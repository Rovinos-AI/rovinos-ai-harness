// SPDX-License-Identifier: Apache-2.0
import { ProtocolError, type CallToolResult } from "@modelcontextprotocol/client";
import { Code, JsonValue, compileJsonSchema } from "@harness/schemas";
import type { JsonValue as JsonValueType, ServerConfig } from "@harness/schemas";
import { attr, defineSemconvSpan, withSpan } from "@harness/telemetry";
import { countMcpDiscoveryFailed } from "@harness/telemetry";
import { context as otelContext, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
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

export type McpToolPortOptions = {
  /** Set only when an outer OffloadingToolPort consumes binary payloads. */
  readonly offloadBinaryResults?: boolean;
};

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
  readonly binaryPayload?: Uint8Array;
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
  const resource = isResource ? resourceBytes(block) : undefined;
  const genuineBinary = isResource
    ? isRecord(block.resource) &&
      typeof block.resource.blob === "string" &&
      typeof block.resource.text !== "string"
    : ["image", "audio", "blob"].includes(block.type);
  const bytes = isResource ? resource?.bytes : genuineBinary ? binaryBytes(block.data) : undefined;
  const mimeType = isResource
    ? (resource?.mimeType ?? "application/octet-stream")
    : typeof block.mimeType === "string"
      ? block.mimeType
      : "application/octet-stream";
  const byteCount = bytes?.byteLength ?? 0;
  const hasLargeBinary = genuineBinary && byteCount > SMALL_BINARY_BYTES;
  const type = block.type;
  const metadata = { type, mimeType, bytes: byteCount };
  const rawBlockData = isResource ? resource?.data : block.data;
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
    ...(hasLargeBinary && bytes !== undefined ? { binaryPayload: bytes } : {}),
  };
}

function normalizedResult(result: CallToolResult): {
  readonly value: JsonValueType;
  readonly offloadValue: JsonValueType;
  readonly hasLargeBinary: boolean;
  readonly binaryPayload?: Uint8Array;
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
    ...(() => {
      const block = blocks.find(({ hasLargeBinary }) => hasLargeBinary);
      return block?.binaryPayload === undefined ? {} : { binaryPayload: block.binaryPayload };
    })(),
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

function failure(code: string, result: JsonValueType = null): McpToolExecutionResult {
  return { outcome: "error", errorCode: Code.parse(code), result };
}

function setOutcome(
  span: Span,
  outcome: McpToolExecutionResult,
): void {
  span.setAttribute("harness.outcome", outcome.outcome);
  if (outcome.outcome === "error") {
    span.setAttribute("harness.error.code", outcome.errorCode ?? "mcp_error");
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

/**
 * Executes tools discovered from configured MCP servers using normalized registry identifiers.
 *
 * Tool error content remains a result value and flows through PII/offloading; error metadata is
 * limited to stable codes and never copies server text into telemetry.
 */
export class McpToolPort {
  private constructor(
    private readonly pool: McpPool,
    private readonly registry: ToolRegistry,
    private readonly options: McpToolPortOptions,
  ) {}

  /**
   * Connects to configured servers to discover the tool registry.
   *
   * Discovery failure is logged and fails startup rather than silently omitting tools. Connections
   * may reconnect lazily after successful discovery.
   *
   * @param servers - Validated server configurations.
   * @param dependencies - Secret resolver, safe logger, and optional transport factory.
   * @returns A managed tool port owning its server pool.
   */
  static async create(
    servers: readonly ServerConfig[],
    dependencies: McpToolPortDependencies,
    options: McpToolPortOptions = {},
  ): Promise<McpToolPort> {
    const pool = new McpPool(servers, dependencies);
    try {
      const discovered = await Promise.all(
        servers.map(async (server) => {
          try {
            return { config: server, tools: await pool.listTools(server.id) };
          } catch {
            dependencies.logger?.log({ code: "mcp_discovery_failed", serverId: server.id });
            countMcpDiscoveryFailed();
            throw new McpConnectionError("mcp_list_tools_failed");
          }
        }),
      );
      return new McpToolPort(pool, new ToolRegistry(discovered), options);
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
      async (span) =>
        otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
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
              setOutcome(span, outcome);
              return outcome;
            }
            if (!isRecord(call.args)) {
              outcome = failure("args_invalid");
              setOutcome(span, outcome);
              return outcome;
            }
            const result = await connection.callTool(
              { name: route.nativeName, arguments: call.args },
              route.inputSchema,
              { signal },
              route.tool,
            );
            if (Reflect.get(result, "resultType") === "input_required") {
              outcome = failure("mcp_input_required_unsupported");
            } else {
              const mapped = normalizedResult(result);
              const serialized = JSON.stringify(mapped.offloadValue) ?? "null";
              if (Buffer.byteLength(serialized, "utf8") > route.server.maxResultBytes) {
                outcome = failure("result_too_large");
              } else if (mapped.hasLargeBinary) {
                outcome =
                  this.options.offloadBinaryResults === true && mapped.binaryPayload !== undefined
                    ? {
                        outcome: result.isError === true ? "error" : "ok",
                        ...(result.isError === true
                          ? { errorCode: Code.parse("tool_reported_error") }
                          : {}),
                        binary: true,
                        result: Array.from(mapped.binaryPayload),
                      }
                    : failure("binary_result_unavailable");
              } else if (result.isError === true) {
                outcome = failure("tool_reported_error", mapped.value);
              } else {
                outcome = { outcome: "ok", result: mapped.value };
              }
            }
          }
        } catch (error) {
          outcome = failure(errorCode(error, signal));
        }
        setOutcome(span, outcome);
        return outcome;
      }),
    );
  }

  /** Closes every managed server connection. */
  close(): Promise<void> {
    return this.pool.close();
  }
}
