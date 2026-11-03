// SPDX-License-Identifier: Apache-2.0
import { ProtocolError } from "@modelcontextprotocol/client";
import { McpConnectionError } from "./connection.js";
import { McpProtocolError } from "./errors.js";

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

/** Maps an untrusted MCP failure to a stable, closed error code. */
export function errorCode(error: unknown, signal: AbortSignal): string {
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
      case "mcp_apps_unsupported":
        return "mcp_apps_unsupported";
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
