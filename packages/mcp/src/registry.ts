// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  Code,
  ContractError,
  HarnessError,
  JsonValue,
  ToolSpecSchema,
  UNREGISTERED_TOOL_ID,
  compileJsonSchema,
  type JsonValue as JsonValueType,
  type ServerConfig,
  type ToolSpec,
} from "@harness/schemas";
import type { McpTool } from "./tool-list.js";

export { UNREGISTERED_TOOL_ID };

const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_ID_LENGTH = 64;
const TOOL_ID_HASH_LENGTH = 6;

/** A server and the tools returned by its `tools/list` request. */
export interface ToolRegistryServer {
  readonly config: ServerConfig;
  readonly tools: readonly McpTool[];
}

/** A rejected server tool, safe to report without logging or executing it. */
export interface RejectedTool {
  readonly serverId: Code;
  readonly nativeName?: string;
  readonly reason: Code;
}

/** A tool route retained by the registry for the MCP execution layer. */
export interface ResolvedTool {
  readonly server: ServerConfig;
  readonly nativeName: string;
  readonly inputSchema: JsonValueType;
  readonly outputSchema?: JsonValueType;
}

/** Startup failure raised when two server tools normalize to the same id. */
export class ToolRegistryError extends HarnessError {
  readonly code = "tool_id_collision";
  readonly serverIds: readonly [Code, Code];

  /**
   * Creates a collision error that identifies both configured servers.
   *
   * @param firstServerId - Server that first registered the normalized id.
   * @param secondServerId - Server whose tool collided with the first.
   */
  constructor(firstServerId: Code, secondServerId: Code) {
    super("tool_id_collision");
    this.name = "ToolRegistryError";
    this.serverIds = [firstServerId, secondServerId];
  }
}

function sanitizeComponent(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]/gu, "_")
    .replaceAll(/_+/gu, "_");
}

/**
 * Normalizes a native MCP tool name into the bounded harness `Code` namespace.
 *
 * Long ids retain a six-hex SHA-256 suffix so distinct server names with the same prefix do not
 * silently collapse after truncation.
 *
 * @param prefix - Configured server tool prefix.
 * @param nativeName - Untrusted native name returned by the MCP server.
 * @returns A lower-case normalized id, potentially longer than the Code limit if the prefix itself
 *   is invalid; the registry rejects ids that do not satisfy `Code`.
 */
export function normalizeToolId(prefix: string, nativeName: string): string {
  const normalized = `${sanitizeComponent(prefix)}.${sanitizeComponent(nativeName)}`;
  if (normalized.length <= MAX_TOOL_ID_LENGTH) {
    return normalized;
  }
  const suffix = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, TOOL_ID_HASH_LENGTH);
  return `${normalized.slice(0, MAX_TOOL_ID_LENGTH - TOOL_ID_HASH_LENGTH - 1)}-${suffix}`;
}

function safeDescription(description: unknown): string {
  if (typeof description !== "string") {
    return "";
  }
  return description
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 1_024);
}

function compileSchema(schema: unknown): JsonValueType {
  compileJsonSchema(schema, { maxBytes: MAX_TOOL_SCHEMA_BYTES });
  const parsed = JsonValue.safeParse(schema);
  if (!parsed.success) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  return parsed.data;
}

function schemaRejectionReason(
  error: unknown,
): "tool_schema_too_large" | "tool_schema_unsupported" {
  return error instanceof ContractError &&
    error.issues.some(({ code }) => code === "size_limit_exceeded")
    ? "tool_schema_too_large"
    : "tool_schema_unsupported";
}

interface RegisteredTool {
  readonly server: ServerConfig;
  readonly nativeName: string;
  readonly spec: ToolSpec;
  readonly inputSchema: JsonValueType;
  readonly outputSchema?: JsonValueType;
  readonly idempotent: boolean;
}

/**
 * Builds the model-visible tool specs and execution metadata from validated server configurations.
 *
 * Descriptions are untrusted text and may contain prompt injection. They are sanitized as display
 * text, exposed only through the `ToolSpec.description` field, and must still pass through the
 * model-input PII boundary before being sent to a provider.
 *
 * @param servers - Configured servers and their discovered tools, in deterministic order.
 */
export class ToolRegistry {
  readonly #tools: RegisteredTool[] = [];
  readonly #byId = new Map<Code, RegisteredTool>();
  readonly #rejected: RejectedTool[] = [];

  constructor(servers: readonly ToolRegistryServer[]) {
    for (const { config, tools } of servers) {
      for (const tool of tools) {
        this.#register(config, tool);
      }
    }
  }

  #register(config: ServerConfig, tool: McpTool): void {
    if (config.toolAllowlist !== undefined && !config.toolAllowlist.includes(tool.name)) {
      this.#reject(config, tool, "tool_not_allowlisted");
      return;
    }
    const toolId = this.#normalizeId(config, tool);
    if (toolId === undefined) {
      return;
    }
    const schemas = this.#compileSchemas(config, tool);
    if (schemas === undefined) {
      return;
    }
    this.#store(config, tool, toolId, schemas);
  }

  #normalizeId(config: ServerConfig, tool: McpTool): Code | undefined {
    const parsedId = Code.safeParse(normalizeToolId(config.toolPrefix, tool.name));
    if (!parsedId.success || tool.name.length === 0) {
      this.#reject(config, tool, "tool_name_invalid");
      return undefined;
    }
    const previous = this.#byId.get(parsedId.data);
    if (previous !== undefined) {
      throw new ToolRegistryError(previous.server.id, config.id);
    }
    return parsedId.data;
  }

  #compileSchemas(
    config: ServerConfig,
    tool: McpTool,
  ): { readonly inputSchema: JsonValueType; readonly outputSchema?: JsonValueType } | undefined {
    try {
      const inputSchema = compileSchema(tool.inputSchema);
      const outputSchema =
        tool.outputSchema === undefined ? undefined : compileSchema(tool.outputSchema);
      return { inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }) };
    } catch (error) {
      this.#reject(config, tool, schemaRejectionReason(error));
      return undefined;
    }
  }

  #store(
    config: ServerConfig,
    tool: McpTool,
    toolId: Code,
    schemas: { readonly inputSchema: JsonValueType; readonly outputSchema?: JsonValueType },
  ): void {
    const { inputSchema, outputSchema } = schemas;
    const spec = ToolSpecSchema.parse({
      toolId,
      description: safeDescription(tool.description),
      inputSchema,
    });
    const annotations = tool.annotations;
    const idempotent =
      config.idempotentTools?.includes(tool.name) === true ||
      (config.trust === "internal" &&
        config.useAnnotations &&
        (annotations?.idempotentHint === true || annotations?.readOnlyHint === true));
    const registered: RegisteredTool = {
      server: config,
      nativeName: tool.name,
      spec,
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      idempotent,
    };
    this.#tools.push(registered);
    this.#byId.set(toolId, registered);
  }

  #reject(config: ServerConfig, tool: McpTool, reason: Code): void {
    this.#rejected.push({ serverId: config.id, nativeName: tool.name, reason });
  }

  /** Returns model-visible tool specs in server and native list order. */
  getToolSpecs(): readonly ToolSpec[] {
    return this.#tools.map(({ spec }) => spec);
  }

  /**
   * Returns execution metadata for a registered tool.
   *
   * @param toolId - Normalized tool id.
   * @returns Retry metadata and the external input schema, or undefined for unknown ids.
   */
  describe(toolId: Code):
    | {
        readonly idempotent: boolean;
        readonly timeoutMs: number;
        readonly inputSchema: JsonValueType;
      }
    | undefined {
    const tool = this.#byId.get(toolId);
    if (tool === undefined) {
      return undefined;
    }
    return {
      idempotent: tool.idempotent,
      timeoutMs: tool.server.timeouts.callMs,
      inputSchema: tool.inputSchema,
    };
  }

  /**
   * Resolves a registered id to its configured server and native name.
   *
   * @param toolId - Normalized tool id.
   * @returns The route and compiled schemas' JSON representations, or undefined if unknown.
   */
  resolve(toolId: Code): ResolvedTool | undefined {
    const tool = this.#byId.get(toolId);
    if (tool === undefined) {
      return undefined;
    }
    return {
      server: tool.server,
      nativeName: tool.nativeName,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    };
  }

  /** Returns rejected tools in discovery order without exposing server error text. */
  rejected(): readonly RejectedTool[] {
    return this.#rejected.map((tool) => ({ ...tool }));
  }
}
