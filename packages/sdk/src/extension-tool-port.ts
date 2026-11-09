// SPDX-License-Identifier: Apache-2.0
import { JsonValue as JsonValueSchema } from "@rovinos/schemas";
import type { Code, JsonValue, Sha256Hex as Sha256HexType, ToolSpec } from "@rovinos/schemas";
import type { ModelToolCall, ToolDescription, ToolExecutionResult, ToolPort } from "@rovinos/core";
import type { ZodType } from "zod";
import { ExtensionError, type ExtensionToolDefinition } from "./extension-contracts.js";
import { isBoundedJsonValue } from "./extension-json.js";
import { canonicalJson, fingerprint } from "./extension-runtime-helpers.js";

/** Runtime-validated extension tool with grant rechecking on each invocation. */
export interface RegisteredTool {
  readonly toolId: ReturnType<typeof Code.parse>;
  readonly name: string;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
  readonly inputJsonSchema: JsonValue;
  readonly description: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly extensionVersion: string;
  isGranted(): boolean;
  readonly execute: ExtensionToolDefinition["execute"];
}

/** Creates the mediated tool port for the set of registered extension tools. */
export function makeExtensionToolPort(
  tools: ReadonlyMap<string, RegisteredTool>,
): ToolPort | undefined {
  if (tools.size === 0) {
    return undefined;
  }
  const get = (toolId: string) => tools.get(toolId);
  const getToolSpecs = (): readonly ToolSpec[] =>
    [...tools.values()]
      .filter((tool) => tool.isGranted())
      .map((tool) => ({
        toolId: tool.toolId,
        description: tool.description,
        inputSchema: tool.inputJsonSchema,
      }));
  const catalogFingerprints = (): Readonly<Record<string, Sha256HexType>> =>
    Object.fromEntries(
      [...tools.values()]
        .filter((tool) => tool.isGranted())
        .map((tool) => [
          tool.toolId,
          fingerprint(
            `${tool.extensionVersion}\0${tool.description}\0${canonicalJson(tool.inputJsonSchema)}`,
          ),
        ]),
    );
  const catalogVersion = () => {
    const fingerprints = catalogFingerprints();
    return Object.keys(fingerprints).length === 0
      ? undefined
      : fingerprint(canonicalJson(fingerprints));
  };
  const describe = (toolId: ReturnType<typeof Code.parse>): ToolDescription | undefined => {
    const tool = get(toolId);
    return tool?.isGranted() !== true
      ? undefined
      : {
          idempotent: false,
          timeoutMs: tool.timeoutMs,
          inputSchema: tool.inputJsonSchema,
        };
  };
  return {
    getToolSpecs,
    catalogVersion,
    catalogFingerprints,
    describe,
    execute: (call, context) => executeTool(get(call.toolId), call, context),
    validateInputSchema: (toolId, args) => {
      const tool = get(toolId);
      if (tool?.isGranted() !== true || !isBoundedJsonValue(args)) {
        return Promise.resolve(false);
      }
      return Promise.resolve(tool.inputSchema.safeParse(args).success);
    },
  };
}

async function executeTool(
  tool: RegisteredTool | undefined,
  call: ModelToolCall,
  context: Parameters<NonNullable<ToolPort["execute"]>>[1],
): Promise<ToolExecutionResult> {
  if (tool === undefined) {
    return { outcome: "error", errorCode: "unknown_tool", result: null };
  }
  if (!tool.isGranted()) {
    return { outcome: "error", errorCode: "extension_grant_missing", result: null };
  }
  context.signal.throwIfAborted();
  if (!isBoundedJsonValue(call.args)) {
    return { outcome: "error", errorCode: "extension_input_invalid", result: null };
  }
  const input = parseToolInput(tool, call.args);
  if (!input.success) {
    return { outcome: "error", errorCode: "extension_input_invalid", result: null };
  }
  try {
    const output = await tool.execute(input.value, { signal: context.signal });
    context.signal.throwIfAborted();
    return toolResult(tool, output);
  } catch (error) {
    if (context.signal.aborted) {
      throw error;
    }
    return { outcome: "error", errorCode: "extension_execution_failed", result: null };
  }
}

function parseToolInput(
  tool: RegisteredTool,
  value: JsonValue,
): { readonly success: true; readonly value: unknown } | { readonly success: false } {
  try {
    const parsed = tool.inputSchema.safeParse(value);
    return parsed.success ? { success: true, value: parsed.data } : { success: false };
  } catch {
    return { success: false };
  }
}

function toolResult(tool: RegisteredTool, output: unknown): ToolExecutionResult {
  try {
    const parsed = tool.outputSchema.safeParse(output);
    if (!parsed.success || !isBoundedJsonValue(parsed.data, false, tool.maxOutputBytes)) {
      return { outcome: "error", errorCode: "extension_result_invalid", result: null };
    }
    return {
      outcome: "ok",
      result: JsonValueSchema.parse(parsed.data),
      resultLimitBytes: tool.maxOutputBytes,
    };
  } catch {
    return { outcome: "error", errorCode: "extension_result_invalid", result: null };
  }
}

/** Combines base and extension tools while preserving the base port's mediation hooks. */
export function composeToolPorts(base: ToolPort | undefined, additions: ToolPort): ToolPort {
  const initialAdditionSpecs = additions.getToolSpecs?.() ?? [];
  assertNoToolCollisions(base, initialAdditionSpecs);
  const additionToolIds = new Set(initialAdditionSpecs.map(({ toolId }) => toolId));
  const portFor = (toolId: ReturnType<typeof Code.parse>): ToolPort =>
    additionToolIds.has(toolId) ? additions : (base ?? additions);
  return {
    ...optionalPortHooks(base, additions, portFor),
    getToolSpecs: () => mergedToolSpecs(base, additions),
    catalogVersion: () => mergedCatalogVersion(base, additions),
    catalogFingerprints: () => mergedCatalogFingerprints(base, additions),
    describe: (toolId, args) => portFor(toolId).describe(toolId, args),
    resumeStrategy: (toolId) => portFor(toolId).resumeStrategy?.(toolId),
    execute: (call, context) => portFor(call.toolId).execute(call, context),
  };
}

function assertNoToolCollisions(base: ToolPort | undefined, additions: readonly ToolSpec[]): void {
  const baseToolIds = new Set((base?.getToolSpecs?.() ?? []).map(({ toolId }) => toolId));
  for (const spec of additions) {
    if (baseToolIds.has(spec.toolId) || base?.describe(spec.toolId) !== undefined) {
      throw new ExtensionError("extension_contribution_invalid");
    }
  }
}

function mergedToolSpecs(base: ToolPort | undefined, additions: ToolPort): readonly ToolSpec[] {
  return [...(base?.getToolSpecs?.() ?? []), ...(additions.getToolSpecs?.() ?? [])];
}

function mergedCatalogFingerprints(
  base: ToolPort | undefined,
  additions: ToolPort,
): ReturnType<NonNullable<ToolPort["catalogFingerprints"]>> {
  return {
    ...(base?.catalogFingerprints?.() ?? {}),
    ...(additions.catalogFingerprints?.() ?? {}),
  };
}

function mergedCatalogVersion(
  base: ToolPort | undefined,
  additions: ToolPort,
): ReturnType<NonNullable<ToolPort["catalogVersion"]>> {
  const baseVersion = base?.catalogVersion?.();
  const additionalVersion = additions.catalogVersion?.();
  if (baseVersion === undefined && additionalVersion === undefined) {
    return undefined;
  }
  return fingerprint(`${baseVersion ?? ""}\0${additionalVersion ?? ""}`);
}

function optionalPortHooks(
  base: ToolPort | undefined,
  additions: ToolPort,
  portFor: (toolId: ReturnType<typeof Code.parse>) => ToolPort,
): Pick<ToolPort, "pinForRun" | "prepare" | "validateInputSchema"> {
  const pinForRun: ToolPort["pinForRun"] =
    base?.pinForRun === undefined
      ? undefined
      : async (options) => composeToolPorts(await base.pinForRun?.(options), additions);
  const prepare: ToolPort["prepare"] =
    base?.prepare === undefined
      ? undefined
      : (call, context) => base.prepare?.(call, context) ?? Promise.resolve(call);
  const hasInputValidation =
    base?.validateInputSchema !== undefined || additions.validateInputSchema !== undefined;
  const validateInputSchema: ToolPort["validateInputSchema"] = hasInputValidation
    ? (toolId, args, schema, context) =>
        portFor(toolId).validateInputSchema?.(toolId, args, schema, context) ??
        Promise.resolve(true)
    : undefined;
  return {
    ...(pinForRun === undefined ? {} : { pinForRun }),
    ...(prepare === undefined ? {} : { prepare }),
    ...(validateInputSchema === undefined ? {} : { validateInputSchema }),
  };
}
