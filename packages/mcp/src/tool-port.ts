// SPDX-License-Identifier: Apache-2.0
import {
  isInputRequiredResult,
  ProtocolError,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { Code, HarnessError, JsonValue, compileJsonSchema } from "@harness/schemas";
import type { InputResponse, JsonValue as JsonValueType, ServerConfig } from "@harness/schemas";
import * as telemetry from "@harness/telemetry";
import { context as otelContext, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { McpConnectionError } from "./connection.js";
import type { McpConnection, McpConnectionDependencies } from "./connection.js";
import type { OAuthTokenStore } from "./oauth/token-store.js";
import { McpProtocolError } from "./errors.js";
import { countMcpInputRequest } from "@harness/telemetry";
import {
  type ElicitationInputOutcome,
  type ElicitationPort,
  type ElicitationRetry,
} from "./elicitation/mrtr.js";
import { requestsSensitiveFormField } from "./elicitation/sensitive.js";
import {
  InputRequestContentSchema,
  McpInputRequestError,
  validateInputRequiredResult,
} from "./elicitation/validate.js";
import { McpPool } from "./pool.js";
import { ToolRegistry, type ResolvedTool } from "./registry.js";

const MCP_CALL_SPAN = telemetry.defineSemconvSpan(
  "mcp.client.call",
  {
    "mcp.method.name": telemetry.attr.enum(["tools/call"]),
    "harness.mcp.server_id": telemetry.attr.code(),
    "harness.tool.id": telemetry.attr.code(),
    "harness.outcome": telemetry.attr.enum(["ok", "error"]),
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
}

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

interface ResourceBytes {
  readonly bytes?: Uint8Array;
  readonly data?: string;
  readonly mimeType: string;
}

function resourceBytes(block: Record<string, unknown>): ResourceBytes {
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

function isGenuineBinary(block: Record<string, unknown>, isResource: boolean): boolean {
  if (!isResource) {
    return block.type === "image" || block.type === "audio" || block.type === "blob";
  }
  return (
    isRecord(block.resource) &&
    typeof block.resource.blob === "string" &&
    typeof block.resource.text !== "string"
  );
}

function blockBytes(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
  genuineBinary: boolean,
): Uint8Array | undefined {
  if (isResource) {
    return resource?.bytes;
  }
  return genuineBinary ? binaryBytes(block.data) : undefined;
}

function blockMimeType(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
): string {
  if (isResource) {
    return resource?.mimeType ?? "application/octet-stream";
  }
  return typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
}

function blockData(
  block: Record<string, unknown>,
  isResource: boolean,
  resource: ResourceBytes | undefined,
): string | undefined {
  const value = isResource ? resource?.data : block.data;
  return typeof value === "string" ? value : undefined;
}

function visibleBlock(
  metadata: { readonly type: string; readonly mimeType: string; readonly bytes: number },
  data: string | undefined,
  hasLargeBinary: boolean,
): JsonValueType {
  if (data === undefined || hasLargeBinary) {
    return metadata;
  }
  return { ...metadata, data };
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
  const genuineBinary = isGenuineBinary(block, isResource);
  const bytes = blockBytes(block, isResource, resource, genuineBinary);
  const mimeType = blockMimeType(block, isResource, resource);
  const byteCount = bytes?.byteLength ?? 0;
  const hasLargeBinary = genuineBinary && byteCount > SMALL_BINARY_BYTES;
  const type = block.type;
  const metadata = { type, mimeType, bytes: byteCount };
  const data = blockData(block, isResource, resource);
  const visible = visibleBlock(metadata, data, hasLargeBinary);
  const offloadBlock = data === undefined ? metadata : { ...metadata, data };
  return {
    block: visible,
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
  const largeBinaryBlock = blocks.find(({ hasLargeBinary }) => hasLargeBinary);
  return {
    value,
    offloadValue,
    hasLargeBinary: blocks.some(({ hasLargeBinary }) => hasLargeBinary),
    ...(largeBinaryBlock?.binaryPayload === undefined
      ? {}
      : { binaryPayload: largeBinaryBlock.binaryPayload }),
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

function isRecorderFailure(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    (error.code === "run_event_record_failed" || error.code === "pii_summary_record_failed")
  );
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

type TokenizedInputRequest = ReturnType<typeof InputRequestContentSchema.parse>[number] & {
  readonly inputKey: string;
};

interface ProtectedInputRequests {
  readonly tokenizedRequests: readonly TokenizedInputRequest[];
  readonly protectedRequestState?: string;
  readonly rawKeysByProtectedKey: ReadonlyMap<string, string>;
  readonly sensitiveInputKeys: readonly string[];
  readonly sensitiveKeys: ReadonlySet<string>;
}

async function protectInputRequests(
  validated: ReturnType<typeof validateInputRequiredResult>,
  tokenizeHumanInput: (value: JsonValueType) => Promise<JsonValueType>,
  protectInputMetadata: (value: string) => Promise<string>,
): Promise<ProtectedInputRequests> {
  const tokenized = await tokenizeHumanInput(
    JsonValue.parse(validated.inputRequests.map(({ inputKey: _inputKey, ...request }) => request)),
  );
  const parsed = InputRequestContentSchema.parse(tokenized);
  const protectedKeys = await Promise.all(
    validated.inputRequests.map(({ inputKey }) => protectInputMetadata(inputKey)),
  );
  const protectedRequestState =
    validated.requestState === undefined
      ? undefined
      : await protectInputMetadata(validated.requestState);
  const rawKeysByProtectedKey = new Map(
    protectedKeys.map((protectedKey, index) => [
      protectedKey,
      validated.inputRequests[index]?.inputKey ?? "",
    ]),
  );
  const tokenizedRequests = parsed.map((request, index) => {
    if (validated.inputRequests[index] === undefined) {
      throw new Error("Validated request count changed.");
    }
    const inputKey = protectedKeys[index];
    if (inputKey === undefined) {
      throw new Error("Protected request key is missing.");
    }
    return { ...request, inputKey };
  });
  const sensitiveInputKeys = tokenizedRequests
    .filter((request) => {
      const originalKey = rawKeysByProtectedKey.get(request.inputKey);
      return validated.inputRequests.some(
        (original) => original.inputKey === originalKey && requestsSensitiveFormField(original),
      );
    })
    .map(({ inputKey }) => inputKey);
  return {
    tokenizedRequests,
    ...(protectedRequestState === undefined ? {} : { protectedRequestState }),
    rawKeysByProtectedKey,
    sensitiveInputKeys,
    sensitiveKeys: new Set(sensitiveInputKeys),
  };
}

function restoreInputResponses(
  protectedResponses: Readonly<Record<string, InputResponse>>,
  rawKeysByProtectedKey: ReadonlyMap<string, string>,
): Record<string, InputResponse> | undefined {
  const rawResponses = new Map<string, InputResponse>();
  for (const [protectedKey, response] of Object.entries(protectedResponses)) {
    const inputKey = rawKeysByProtectedKey.get(protectedKey);
    if (inputKey === undefined) {
      return undefined;
    }
    rawResponses.set(inputKey, response);
  }
  return Object.fromEntries(rawResponses);
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
}): Promise<McpToolExecutionResult> {
  const { connection, route, call, signal, offloadBinaryResults, elicitation } = options;
  if (signal.aborted) {
    return failure("mcp_timeout");
  }
  if (!isRecord(call.args) || !validToolArgs(route.inputSchema, call.args)) {
    return failure("args_invalid");
  }
  let inputRetry = options.inputRetry;
  let round = inputRetry?.round ?? 0;
  let result: CallToolResult;
  for (;;) {
    try {
      result = await connection.callTool(
        { name: route.nativeName, arguments: call.args },
        route.inputSchema,
        { signal },
        route.tool,
        inputRetry,
      );
    } catch (error) {
      return failure(errorCode(error, signal));
    }
    if (!isInputRequiredResult(result)) {
      break;
    }
    round += 1;
    if (round > route.server.elicitation.maxRounds) {
      countMcpInputRequest("rounds_exceeded");
      return failure("mcp_input_rounds_exceeded");
    }
    let validated;
    try {
      validated = validateInputRequiredResult(result, route.server);
    } catch (error) {
      countMcpInputRequest("rejected");
      return failure(
        error instanceof McpInputRequestError ? error.code : "mcp_input_request_invalid",
      );
    }
    if (elicitation === undefined) {
      countMcpInputRequest("rejected");
      return failure("mcp_input_request_invalid");
    }
    const protectInputMetadata = options.protectInputMetadata;
    if (options.tokenizeHumanInput === undefined || protectInputMetadata === undefined) {
      countMcpInputRequest("rejected");
      return failure("mcp_input_request_invalid");
    }
    let protectedRequests: ProtectedInputRequests;
    try {
      protectedRequests = await protectInputRequests(
        validated,
        options.tokenizeHumanInput,
        protectInputMetadata,
      );
    } catch (error) {
      if (isRecorderFailure(error)) {
        throw error;
      }
      return failure("mcp_input_request_invalid");
    }
    let inputOutcome: ElicitationInputOutcome;
    try {
      inputOutcome = await elicitation.handleInputRequired({
        callId: call.callId,
        serverId: route.server.id,
        round,
        maxPerRun: route.server.elicitation.maxPerRun,
        inputRequests: protectedRequests.tokenizedRequests,
        sensitiveInputKeys: protectedRequests.sensitiveInputKeys,
        signal,
        ...(protectedRequests.protectedRequestState === undefined
          ? {}
          : { requestState: protectedRequests.protectedRequestState }),
      });
    } catch (error) {
      if (isRecorderFailure(error)) {
        throw error;
      }
      return failure("mcp_input_request_invalid");
    }
    if (inputOutcome.kind === "error") {
      countMcpInputRequest(
        inputOutcome.errorCode === "mcp_input_rate_limited" ? "rate_limited" : "rejected",
      );
      return failure(inputOutcome.errorCode);
    }
    for (const request of protectedRequests.tokenizedRequests) {
      countMcpInputRequest(
        protectedRequests.sensitiveKeys.has(request.inputKey) ? "declined_sensitive" : "asked",
      );
    }
    if (inputOutcome.kind === "suspend") {
      return {
        outcome: "ok",
        result: null,
        suspend: true,
        suspendReason: "awaiting_input",
      };
    }
    const inputResponses = restoreInputResponses(
      inputOutcome.inputResponses,
      protectedRequests.rawKeysByProtectedKey,
    );
    if (inputResponses === undefined) {
      return failure("mcp_input_request_invalid");
    }
    inputRetry = {
      inputResponses,
      round,
      ...(validated.requestState === undefined ? {} : { requestState: validated.requestState }),
    };
  }
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
