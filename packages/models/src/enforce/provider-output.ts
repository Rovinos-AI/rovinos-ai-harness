// SPDX-License-Identifier: Apache-2.0
import { Code, type Capabilities, type ModelRequest, type ModelResponse } from "@harness/schemas";
import type { z } from "zod";
import {
  EnforcementRungUnavailableError,
  OutputWithToolsUnsupportedError,
  selectEnforcementRung,
  type EnforcementResult,
  type EnforcementRung,
  type TokenizedEnforcementResult,
  type ValueTransform,
} from "./index.js";
import { enforceNativeOutput, withNativeOutputSchema } from "./rung-native.js";
import { enforceToolOutput, withForcedOutputTool } from "./rung-tool.js";
import { enforcePromptOutput, withPromptOutput } from "./rung-prompt.js";
import { lowerForProvider, schemaHash, toJsonSchema } from "../json-schema.js";
import { providerSchemaRules } from "../provider-schema-rules.js";

/** Enforcement rung and prepared provider request. */
export interface PreparedEnforcement {
  readonly request: ModelRequest;
  readonly rung?: EnforcementRung;
  readonly droppedSchemaKeywords?: z.infer<typeof Code>[];
}

interface ProviderEnforcement {
  readonly kind: string;
  readonly capabilities: Capabilities;
  readonly maxRung?: EnforcementRung;
}

interface ProviderOutputContext<OutputSchema extends z.ZodType> {
  readonly outputSchema?: OutputSchema;
  readonly valueTransform?: ValueTransform | undefined;
}

/**
 * Prepares a model request with the provider-compatible output schema and enforcement rung.
 *
 * @param request - Provider-neutral request to prepare.
 * @param outputSchema - Caller schema for structured output, when requested.
 * @param provider - Provider kind, capabilities, and configured rung cap.
 * @returns Prepared request and selected validation rung.
 */
export function prepareEnforcementRequest(
  request: ModelRequest,
  outputSchema: z.ZodType | undefined,
  provider: ProviderEnforcement,
): PreparedEnforcement {
  if (outputSchema === undefined) {
    return { request };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new OutputWithToolsUnsupportedError();
  }

  const schemaRules = providerSchemaRules(provider.kind);
  let rung: EnforcementRung | undefined;
  if (schemaRules === undefined) {
    rung = provider.maxRung === "native" || provider.maxRung === "tool" ? undefined : "prompt";
  } else {
    rung = selectEnforcementRung(provider.capabilities, provider.maxRung);
  }
  if (rung === undefined) {
    throw new EnforcementRungUnavailableError();
  }

  const loweredSchema =
    schemaRules === undefined ? undefined : lowerForProvider(outputSchema, provider.kind);
  const schema = loweredSchema?.schema ?? toJsonSchema(outputSchema);
  const output = {
    name: request.output?.name ?? "result",
    schema,
    schemaHash: schemaHash(schema),
  };
  return {
    request: prepareRequestForRung(request, output, rung),
    rung,
    ...(loweredSchema === undefined ? {} : { droppedSchemaKeywords: loweredSchema.dropped }),
  };
}

function prepareRequestForRung(
  request: ModelRequest,
  output: NonNullable<ModelRequest["output"]>,
  rung: EnforcementRung,
): ModelRequest {
  if (rung === "native") {
    return withNativeOutputSchema(request, output);
  }
  if (rung === "tool") {
    return withForcedOutputTool(request, output);
  }
  return withPromptOutput(request, output);
}

/**
 * Validates provider output using the selected enforcement rung.
 *
 * @param parts - Provider response parts.
 * @param context - Output schema and optional value-preserving validator.
 * @param rung - Selected structured-output enforcement rung.
 * @returns Filtered response parts and optional enforcement result.
 */
export async function enforceProviderOutput<OutputSchema extends z.ZodType>(
  parts: ModelResponse["parts"],
  context: ProviderOutputContext<OutputSchema>,
  rung: EnforcementRung | undefined,
): Promise<{
  readonly parts: ModelResponse["parts"];
  readonly result?: EnforcementResult<OutputSchema> | TokenizedEnforcementResult;
}> {
  if (context.outputSchema === undefined || rung === undefined) {
    return { parts };
  }
  const { outputSchema, valueTransform } = context;
  if (rung === "native") {
    const hasToolCall = parts.some((part) => part.type === "tool_call");
    return {
      parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
      result:
        valueTransform === undefined
          ? await enforceNativeOutput(parts, outputSchema)
          : await enforceNativeOutput(parts, outputSchema, valueTransform),
    };
  }
  if (rung === "tool") {
    const enforced =
      valueTransform === undefined
        ? await enforceToolOutput(parts, outputSchema)
        : await enforceToolOutput(parts, outputSchema, valueTransform);
    return { parts: enforced.parts, result: enforced.result };
  }
  const hasToolCall = parts.some((part) => part.type === "tool_call");
  return {
    parts: hasToolCall ? parts.filter((part) => part.type !== "tool_call") : parts,
    result:
      valueTransform === undefined
        ? await enforcePromptOutput(parts, outputSchema)
        : await enforcePromptOutput(parts, outputSchema, valueTransform),
  };
}
