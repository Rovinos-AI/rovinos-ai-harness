// SPDX-License-Identifier: Apache-2.0
import {
  SdkError,
  SdkErrorCode,
  type ElicitRequestURLParams,
} from "@modelcontextprotocol/client";
import { HarnessError } from "@rovinos/schemas";

/** Safe protocol failure retaining only the numeric JSON-RPC code. */
export class McpProtocolError extends HarnessError {
  override readonly code = "mcp_protocol_error";

  /** Creates a protocol error, retaining only validated URL inputs for durable tokenization. */
  constructor(
    readonly protocolCode: number,
    readonly urlElicitations?: readonly ElicitRequestURLParams[],
  ) {
    super("mcp_protocol_error");
  }
}

/** Stable failures raised by an MCP connection without exposing server text. */
export type McpConnectionErrorCode =
  | "mcp_connect_failed"
  | "mcp_connect_timeout"
  | "mcp_auth_required"
  | "mcp_connection_lost"
  | "mcp_list_tools_failed"
  | "mcp_too_many_tools"
  | "mcp_tool_arguments_invalid"
  | "mcp_tool_call_failed";

/** Safe connection error with a closed code and no remote-provided message. */
export class McpConnectionError extends HarnessError {
  override readonly code: McpConnectionErrorCode;

  /** Creates a safe MCP error. */
  constructor(code: McpConnectionErrorCode) {
    super(code);
    this.code = code;
  }
}

const SDK_CONNECTION_LOSS_CODES: ReadonlySet<unknown> = new Set([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
  SdkErrorCode.ClientHttpFailedToOpenStream,
  SdkErrorCode.ClientHttpFailedToTerminateSession,
]);

const NODE_CONNECTION_LOSS_CODES: ReadonlySet<unknown> = new Set([
  "CONNECTION_CLOSED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
]);

/**
 * Classifies a failure as a lost connection from error types and codes only; error messages can
 * carry server text and never influence control flow.
 */
export function isConnectionLossError(error: unknown): boolean {
  if (error instanceof SdkError) {
    return SDK_CONNECTION_LOSS_CODES.has(error.code);
  }
  if (error instanceof McpConnectionError) {
    return error.code === "mcp_connection_lost";
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    NODE_CONNECTION_LOSS_CODES.has(error.code)
  );
}
