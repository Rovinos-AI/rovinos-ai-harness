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

const CONNECTION_ERROR_CODES: Record<McpConnectionError["code"], string> = {
  mcp_connect_failed: "mcp_error",
  mcp_connect_timeout: "mcp_timeout",
  mcp_auth_required: "mcp_auth_required",
  mcp_connection_lost: "mcp_connection_lost",
  mcp_list_tools_failed: "mcp_error",
  mcp_too_many_tools: "mcp_error",
  mcp_discovery_page_limit: "mcp_error",
  mcp_discovery_schema_limit: "mcp_error",
  mcp_discovery_data_limit: "mcp_error",
  mcp_discovery_timeout: "mcp_timeout",
  mcp_discovery_cancelled: "mcp_timeout",
  mcp_response_too_large: "mcp_response_too_large",
  mcp_resource_grant_invalid: "mcp_error",
  mcp_resource_access_denied: "mcp_error",
  mcp_resources_unavailable: "mcp_error",
  mcp_list_resources_failed: "mcp_error",
  mcp_too_many_resources: "mcp_error",
  mcp_resource_uri_invalid: "mcp_error",
  mcp_resource_content_unsupported: "mcp_error",
  mcp_resource_tokenization_failed: "mcp_error",
  mcp_resource_request_too_large: "mcp_response_too_large",
  mcp_resource_timeout: "mcp_timeout",
  mcp_resources_changed: "mcp_error",
  mcp_resource_subscription_unavailable: "mcp_error",
  mcp_read_resource_failed: "mcp_error",
  mcp_apps_unsupported: "mcp_apps_unsupported",
  mcp_tool_arguments_invalid: "args_invalid",
  mcp_tool_call_failed: "mcp_error",
};

function connectionErrorCode(code: McpConnectionError["code"]): string {
  return CONNECTION_ERROR_CODES[code];
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
    return connectionErrorCode(error.code);
  }
  return "mcp_error";
}
