// SPDX-License-Identifier: Apache-2.0
import {
  isInputRequiredResult,
  ProtocolError,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { Code, compileJsonSchema } from "@rovinos/schemas";
import type { JsonValue as JsonValueType, ServerConfig } from "@rovinos/schemas";
import * as telemetry from "@rovinos/telemetry";
import { context as otelContext, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { McpConnectionError } from "./connection.js";
import type { McpConnection, McpConnectionDependencies } from "./connection.js";
import type { OAuthTokenStore } from "./oauth/token-store.js";
import { McpProtocolError } from "./errors.js";
import type { ElicitationPort, ElicitationRetry } from "./elicitation/mrtr.js";
import type { ElicitationUrlOptions } from "./elicitation/url.js";
import { handleInputRequiredCall } from "./input-required-call.js";
import { McpPool } from "./pool.js";
import { ToolRegistry, type ResolvedTool } from "./registry.js";
import { normalizedResult } from "./tool-result.js";

const MCP_CALL_SPAN = telemetry.defineSemconvSpan(
  "mcp.client.call",
  {
    "mcp.method.name": telemetry.attr.enum(["tools/call"]),
    "harness.mcp.server_id": telemetry.attr.code(),
    "harness.tool.id": telemetry.attr.code(),
    "harness.outcome": telemetry.attr.enum(["ok", "error"]),
  },
  { taskId: "6.5", packageName: "@rovinos/mcp" },
);

/** An MCP tool invocation structurally compatible with the core tool port. */
export interface McpToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly args: JsonValueType;
}

/** Context required to execute one MCP tool call. */
export interface McpToolCallContext {
  readonly signal: AbortSignal;
  /** Core-owned durable handler for MRTR input requests. */
  readonly elicitation?: ElicitationPort;
  /** Resolved responses and opaque state for a resumed tool call. */
  readonly inputRetry?: ElicitationRetry;
  /** Tokenizes server-provided request content before durable recording. */
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  /** Stores opaque correlation values in the run-scoped encrypted vault. */
  readonly protectInputMetadata?: (value: string) => Promise<string>;
}

/** Safe tool result structurally compatible with the core tool port. */
export interface McpToolExecutionResult {
  readonly binary?: boolean;
  readonly suspend?: boolean;
  readonly suspendReason?: "awaiting_input";
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: string;
}

/** Dependencies for constructing a managed MCP tool port. */
export type McpToolPortDependencies = McpConnectionDependencies;

/** Execution options for the MCP tool port. */
export interface McpToolPortOptions {
  /** Set only when an outer OffloadingToolPort consumes binary payloads. */
  readonly offloadBinaryResults?: boolean;
  /** Global URL safety policy for MCP elicitation. */
  readonly urlOptions?: ElicitationUrlOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      case "mcp_auth_required":
        return "mcp_auth_required";
      case "mcp_tool_arguments_invalid":
        return "args_invalid";
      case "mcp_connect_timeout":
        return "mcp_timeout";
      case "mcp_connection_lost":
        return "mcp_connection_lost";
      case "mcp_connect_failed":
      case "mcp_list_tools_failed":
      case "mcp_too_many_tools":
      case "mcp_tool_call_failed":
        return "mcp_error";
      default:
        return "mcp_error";
    }
  }
  return "mcp_error";
}

function failure(code: string, result: JsonValueType = null): McpToolExecutionResult {
  return { outcome: "error", errorCode: Code.parse(code), result };
}

function setOutcome(span: Span, outcome: McpToolExecutionResult): void {
  telemetry.setActiveSpanAttribute("harness.outcome", outcome.outcome);
  if (outcome.outcome === "error") {
    telemetry.setActiveSpanAttribute("harness.error.code", outcome.errorCode ?? "mcp_error");
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

function validToolArgs(inputSchema: JsonValueType, args: JsonValueType): boolean {
  try {
    compileJsonSchema(inputSchema)(args);
    return true;
  } catch {
    return false;
  }
}

interface ToolRoundResult {
  readonly kind: "result";
  readonly result: CallToolResult;
}

interface McpObjectToolCall extends Omit<McpToolCall, "args"> {
  readonly args: Record<string, unknown>;
}

type ToolRoundOutcome =
  | ToolRoundResult
  | { readonly kind: "failure"; readonly errorCode: string }
  | { readonly kind: "suspend" };

async function callToolWithInputRounds(options: {
  readonly connection: McpConnection;
  readonly route: ResolvedTool;
  readonly call: McpObjectToolCall;
  readonly signal: AbortSignal;
  readonly elicitation?: ElicitationPort;
  readonly inputRetry?: ElicitationRetry;
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata?: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
}): Promise<ToolRoundOutcome> {
  const { connection, route, call, signal } = options;
  let inputRetry = options.inputRetry;
  let round = inputRetry?.round ?? 0;
  let result: CallToolResult;
  for (;;) {
    try {
      result = await connection.callTool({
        params: { name: route.nativeName, arguments: call.args },
        inputSchema: route.inputSchema,
        options: { signal },
        toolDefinition: route.tool,
        ...(inputRetry === undefined ? {} : { inputRetry }),
      });
    } catch (error) {
      return { kind: "failure", errorCode: errorCode(error, signal) };
    }
    if (!isInputRequiredResult(result)) {
      return { kind: "result", result };
    }
    const handled = await handleInputRequiredCall({
      value: result,
      route,
      call,
      signal,
      round,
      ...(options.elicitation === undefined ? {} : { elicitation: options.elicitation }),
      ...(options.tokenizeHumanInput === undefined
        ? {}
        : { tokenizeHumanInput: options.tokenizeHumanInput }),
      ...(options.protectInputMetadata === undefined
        ? {}
        : { protectInputMetadata: options.protectInputMetadata }),
      ...(options.urlOptions === undefined ? {} : { urlOptions: options.urlOptions }),
    });
    if (handled.kind === "failure" || handled.kind === "suspend") {
      return handled;
    }
    inputRetry = handled.inputRetry;
    round = inputRetry.round;
  }
}

function mapToolResult(
  result: CallToolResult,
  route: ResolvedTool,
  offloadBinaryResults: boolean,
): McpToolExecutionResult {
  const mapped = normalizedResult(result);
  const serialized = JSON.stringify(mapped.offloadValue);
  if (Buffer.byteLength(serialized, "utf8") > route.server.maxResultBytes) {
    return failure("result_too_large");
  }
  if (mapped.hasLargeBinary) {
    if (!offloadBinaryResults || mapped.binaryPayload === undefined) {
      return failure("binary_result_unavailable");
    }
    return {
      outcome: result.isError === true ? "error" : "ok",
      ...(result.isError === true ? { errorCode: Code.parse("tool_reported_error") } : {}),
      binary: true,
      result: Array.from(mapped.binaryPayload),
    };
  }
  if (result.isError === true) {
    return failure("tool_reported_error", mapped.value);
  }
  return { outcome: "ok", result: mapped.value };
}

async function executeRegisteredTool(options: {
  readonly connection: McpConnection;
  readonly route: ResolvedTool;
  readonly call: McpToolCall;
  readonly signal: AbortSignal;
  readonly offloadBinaryResults: boolean;
  readonly elicitation?: ElicitationPort;
  readonly inputRetry?: ElicitationRetry;
  readonly tokenizeHumanInput?: (value: JsonValueType) => Promise<JsonValueType>;
  readonly protectInputMetadata?: (value: string) => Promise<string>;
  readonly urlOptions?: ElicitationUrlOptions;
}): Promise<McpToolExecutionResult> {
  const { route, call, signal } = options;
  if (signal.aborted) {
    return failure("mcp_timeout");
  }
  const args = call.args;
  if (!isRecord(args) || !validToolArgs(route.inputSchema, args)) {
    return failure("args_invalid");
  }
  const roundOutcome = await callToolWithInputRounds({
    ...options,
    call: { ...call, args },
  });
  if (roundOutcome.kind === "failure") {
    return failure(roundOutcome.errorCode);
  }
  if (roundOutcome.kind === "suspend") {
    return { outcome: "ok", result: null, suspend: true, suspendReason: "awaiting_input" };
  }
  return mapToolResult(roundOutcome.result, route, options.offloadBinaryResults);
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
    private readonly oauthTokenStore: OAuthTokenStore | undefined,
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
          } catch (error) {
            dependencies.logger?.log({ code: "mcp_discovery_failed", serverId: server.id });
            telemetry.countMcpDiscoveryFailed();
            if (error instanceof McpConnectionError && error.code === "mcp_auth_required") {
              throw error;
            }
            throw new McpConnectionError("mcp_list_tools_failed");
          }
        }),
      );
      return new McpToolPort(
        pool,
        new ToolRegistry(discovered),
        options,
        dependencies.oauthTokenStore,
      );
    } catch (error) {
      try {
        await pool.close();
      } finally {
        dependencies.oauthTokenStore?.close();
      }
      if (error instanceof McpConnectionError && error.code === "mcp_auth_required") {
        throw error;
      }
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
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(description.timeoutMs)]);
    return telemetry.withSpan(
      MCP_CALL_SPAN,
      {
        "mcp.method.name": "tools/call",
        "harness.mcp.server_id": route.server.id,
        "harness.tool.id": toolId.data,
        "harness.outcome": "error",
      },
      (span) =>
        otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
          const outcome = await executeRegisteredTool({
            connection,
            route,
            call,
            signal,
            offloadBinaryResults: this.options.offloadBinaryResults === true,
            ...(context.elicitation === undefined ? {} : { elicitation: context.elicitation }),
            ...(context.inputRetry === undefined ? {} : { inputRetry: context.inputRetry }),
            ...(context.tokenizeHumanInput === undefined
              ? {}
              : { tokenizeHumanInput: context.tokenizeHumanInput }),
            ...(context.protectInputMetadata === undefined
              ? {}
              : { protectInputMetadata: context.protectInputMetadata }),
            ...(this.options.urlOptions === undefined
              ? {}
              : { urlOptions: this.options.urlOptions }),
          });
          setOutcome(span, outcome);
          return outcome;
        }),
    );
  }

  /** Closes every managed server connection. */
  async close(): Promise<void> {
    try {
      await this.pool.close();
    } finally {
      this.oauthTokenStore?.close();
    }
  }
}
