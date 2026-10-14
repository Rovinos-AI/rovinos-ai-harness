// SPDX-License-Identifier: Apache-2.0
import { ProtocolError, type CallToolResult } from "@modelcontextprotocol/client";
import { Code, JsonValue, compileJsonSchema } from "@harness/schemas";
import type { JsonValue as JsonValueType, ServerConfig } from "@harness/schemas";
import { attr, defineSemconvSpan, withSpan } from "@harness/telemetry";
import type { Span } from "@opentelemetry/api";
import { McpConnectionError } from "./connection.js";
import type { McpConnectionDependencies } from "./connection.js";
import { McpProtocolError } from "./errors.js";
import { McpPool } from "./pool.js";
import { ToolRegistry } from "./registry.js";

const MCP_CALL_SPAN = defineSemconvSpan(
  "mcp.client.call",
  {
    "mcp.method.name": attr.enum(["tools/call"]),
    "harness.mcp.server_id": attr.code(),
    "harness.tool.id": attr.code(),
    "harness.outcome": attr.enum(["ok", "error"]),
  },
  { taskId: "6.5", packageName: "@harness/mcp" },
);

const SMALL_BINARY_BYTES = 8_192;

/** An MCP tool invocation structurally compatible with the core tool port. */
export interface McpToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly args: JsonValueType;
}

/** Context required to execute one MCP tool call. */
export interface McpToolCallContext {
  readonly signal: AbortSignal;
}

/** Safe tool result structurally compatible with the core tool port. */
export interface McpToolExecutionResult {
  readonly binary?: boolean;
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: string;
}

/** Dependencies for constructing a managed MCP tool port. */
export type McpToolPortDependencies = McpConnectionDependencies;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

function resourceBytes(block: Record<string, unknown>): {
  readonly bytes?: Uint8Array;
  readonly data?: string;
  readonly mimeType: string;
} {
  const resource = block.resource;
  if (!isRecord(resource)) {
    return { mimeType: "application/octet-stream" };
  }
  const mimeType =
    typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
  if (typeof resource.text === "string") {
    return { bytes: new TextEncoder().encode(resource.text), data: resource.text, mimeType };
  }
  const bytes = binaryBytes(resource.blob);
  return {
    ...(bytes === undefined ? {} : { bytes }),
    ...(typeof resource.blob === "string" ? { data: resource.blob } : {}),
    mimeType,
  };
}

interface NormalizedBlock {
  readonly block: JsonValueType;
  readonly offloadBlock: JsonValueType;
  readonly hasLargeBinary: boolean;
}

function normalizeBlock(block: unknown): NormalizedBlock {
  if (!isRecord(block) || typeof block.type !== "string") {
    return {
      block: { type: "unknown" },
      offloadBlock: { type: "unknown" },
      hasLargeBinary: false,
    };
  }
  if (block.type === "text" && typeof block.text === "string") {
    const textBlock = { type: "text", text: block.text };
    return { block: textBlock, offloadBlock: textBlock, hasLargeBinary: false };
  }
  const isResource = block.type === "resource";
  const bytes = isResource
    ? resourceBytes(block).bytes
    : binaryBytes(block.data);
  const mimeType = isResource
    ? resourceBytes(block).mimeType
    : typeof block.mimeType === "string"
      ? block.mimeType
      : "application/octet-stream";
  const byteCount = bytes?.byteLength ?? 0;
  const hasLargeBinary = byteCount > SMALL_BINARY_BYTES;
  const type = block.type;
  const metadata = { type, mimeType, bytes: byteCount };
  const rawBlockData = isResource ? resourceBytes(block).data : block.data;
  const blockData = typeof rawBlockData === "string" ? rawBlockData : undefined;
  const visibleBlock =
    blockData !== undefined && !hasLargeBinary
      ? { ...metadata, data: blockData }
      : metadata;
  const offloadBlock =
    blockData === undefined ? metadata : { ...metadata, data: blockData };
  return {
    block: visibleBlock,
    offloadBlock,
    hasLargeBinary,
  };
}

function normalizedResult(result: CallToolResult): {
  readonly value: JsonValueType;
  readonly offloadValue: JsonValueType;
  readonly hasLargeBinary: boolean;
} {
  const blocks = result.content.map(normalizeBlock);
  const content = blocks.map(({ block }) => block);
  const offloadContent = blocks.map(({ offloadBlock }) => offloadBlock);
  const structuredContent: unknown = Reflect.get(result, "structuredContent");
  const value = JsonValue.parse({
    content,
    ...(structuredContent === undefined ? {} : { structured: structuredContent }),
  });
  const offloadValue = JsonValue.parse({
    content: offloadContent,
    ...(structuredContent === undefined ? {} : { structured: structuredContent }),
  });
  return {
    value,
    offloadValue,
    hasLargeBinary: blocks.some(({ hasLargeBinary }) => hasLargeBinary),
  };
}

function protocolErrorCode(protocolCode: number): string {
  switch (protocolCode) {
    case -32602:
      return "mcp_invalid_params";
    case -32601:
      return "mcp_method_not_found";
    case -32603:
      return "mcp_internal_error";
    case -32020:
      return "mcp_header_mismatch";
    case -32021:
      return "mcp_capability_missing";
    case -32022:
      return "mcp_protocol_unsupported";
    default:
      return "mcp_error";
  }
}

function errorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return "mcp_timeout";
  }
  if (error instanceof McpProtocolError) {
    return protocolErrorCode(error.protocolCode);
  }
  if (error instanceof ProtocolError) {
    return protocolErrorCode(error.code);
  }
  if (error instanceof McpConnectionError) {
    switch (error.code) {
      case "mcp_tool_arguments_invalid":
        return "args_invalid";
      case "mcp_connect_timeout":
        return "mcp_timeout";
      case "mcp_connection_lost":
        return "mcp_connection_lost";
      default:
        return "mcp_error";
    }
  }
  return "mcp_error";
}

function failure(code: string): McpToolExecutionResult {
  return { outcome: "error", errorCode: Code.parse(code), result: null };
}

function setOutcome(span: Span, outcome: "ok" | "error"): void {
  span.setAttribute("harness.outcome", outcome);
}

/**
 * Executes tools discovered from configured MCP servers using normalized registry identifiers.
 *
 * Server error content is intentionally discarded: tool errors may contain arbitrary server text,
 * and error outcomes are metadata rather than a trusted transcript channel.
 */
export class McpToolPort {
  private constructor(
    private readonly pool: McpPool,
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * Connects to configured servers to discover the tool registry.
   *
   * Unreachable servers contribute no tools at startup; registered connections reconnect lazily
   * when their tools are called.
   *
   * @param servers - Validated server configurations.
   * @param dependencies - Secret resolver, safe logger, and optional transport factory.
   * @returns A managed tool port owning its server pool.
   */
  static async create(
    servers: readonly ServerConfig[],
    dependencies: McpToolPortDependencies,
  ): Promise<McpToolPort> {
    const pool = new McpPool(servers, dependencies);
    try {
      const discovered = await Promise.all(
        servers.map(async (server) => ({
          config: server,
          tools: await pool.listTools(server.id).catch(() => []),
        })),
      );
      return new McpToolPort(pool, new ToolRegistry(discovered));
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  /** Returns model-visible specifications for all registered tools. */
  getToolSpecs(): ReturnType<ToolRegistry["getToolSpecs"]> {
    return this.registry.getToolSpecs();
  }

  /** Returns the retry metadata and input schema for a registered tool. */
  describe(toolId: string): ReturnType<ToolRegistry["describe"]> {
    const parsedToolId = Code.safeParse(toolId);
    return parsedToolId.success ? this.registry.describe(parsedToolId.data) : undefined;
  }

  /** Executes one tool call and maps every remote failure to a stable code. */
  async execute(call: McpToolCall, context: McpToolCallContext): Promise<McpToolExecutionResult> {
    const toolId = Code.safeParse(call.toolId);
    if (!toolId.success) {
      return failure("mcp_tool_not_found");
    }
    const route = this.registry.resolve(toolId.data);
    const description = this.registry.describe(toolId.data);
    if (route === undefined || description === undefined) {
      return failure("mcp_tool_not_found");
    }
    const connection = this.pool.connection(route.server.id);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(description.timeoutMs),
    ]);
    return withSpan(
      MCP_CALL_SPAN,
      {
        "mcp.method.name": "tools/call",
        "harness.mcp.server_id": route.server.id,
        "harness.tool.id": toolId.data,
        "harness.outcome": "error",
      },
      async (span) => {
        let outcome: McpToolExecutionResult;
        try {
          if (signal.aborted) {
            outcome = failure("mcp_timeout");
          } else {
            const validate = compileJsonSchema(route.inputSchema);
            try {
              validate(call.args);
            } catch {
              outcome = failure("args_invalid");
              setOutcome(span, outcome.outcome);
              return outcome;
            }
            if (!isRecord(call.args)) {
              outcome = failure("args_invalid");
              setOutcome(span, outcome.outcome);
              return outcome;
            }
            const result = await connection.callTool(
              { name: route.nativeName, arguments: call.args },
              route.inputSchema,
              { signal },
            );
            if (result.isError === true) {
              outcome = failure("tool_reported_error");
            } else if (Reflect.get(result, "resultType") === "input_required") {
              outcome = {
                outcome: "ok",
                result: JsonValue.parse({ resultType: "input_required" }),
              };
            } else {
              const mapped = normalizedResult(result);
              const serialized = JSON.stringify(mapped.offloadValue);
              if (serialized === undefined) {
                outcome = failure("mcp_error");
              } else if (Buffer.byteLength(serialized, "utf8") > route.server.maxResultBytes) {
                outcome = failure("result_too_large");
              } else if (mapped.hasLargeBinary) {
                outcome = {
                  outcome: "ok",
                  binary: true,
                  result: Array.from(new TextEncoder().encode(serialized)),
                };
              } else {
                outcome = { outcome: "ok", result: mapped.value };
              }
            }
          }
        } catch (error) {
          outcome = failure(errorCode(error, signal));
        }
        setOutcome(span, outcome.outcome);
        return outcome;
      },
    );
  }

  /** Closes every managed server connection. */
  close(): Promise<void> {
    return this.pool.close();
  }
}
