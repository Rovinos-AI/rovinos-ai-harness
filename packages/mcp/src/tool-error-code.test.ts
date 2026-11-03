// SPDX-License-Identifier: Apache-2.0
import { ProtocolError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { McpConnectionError, McpProtocolError } from "./errors.js";
import type { McpConnectionErrorCode } from "./errors.js";
import { errorCode } from "./tool-error-code.js";

describe("MCP tool error codes", () => {
  it.each([
    [-32602, "mcp_invalid_params"],
    [-32601, "mcp_method_not_found"],
    [-32603, "mcp_internal_error"],
    [-32020, "mcp_header_mismatch"],
    [-32021, "mcp_capability_missing"],
    [-32022, "mcp_protocol_unsupported"],
    [-32000, "mcp_error"],
  ])("maps protocol code %i from both error types without server text", (code, expected) => {
    const signal = new AbortController().signal;
    expect(errorCode(new McpProtocolError(code), signal)).toBe(expected);
    expect(errorCode(new ProtocolError(code, "SYNTHETIC_SERVER_ERROR"), signal)).toBe(expected);
  });

  it.each<[McpConnectionErrorCode, string]>([
    ["mcp_auth_required", "mcp_auth_required"],
    ["mcp_tool_arguments_invalid", "args_invalid"],
    ["mcp_connect_timeout", "mcp_timeout"],
    ["mcp_discovery_timeout", "mcp_timeout"],
    ["mcp_discovery_cancelled", "mcp_timeout"],
    ["mcp_connection_lost", "mcp_connection_lost"],
    ["mcp_apps_unsupported", "mcp_apps_unsupported"],
    ["mcp_connect_failed", "mcp_error"],
    ["mcp_list_tools_failed", "mcp_error"],
    ["mcp_too_many_tools", "mcp_error"],
    ["mcp_discovery_data_limit", "mcp_error"],
    ["mcp_discovery_page_limit", "mcp_error"],
    ["mcp_discovery_schema_limit", "mcp_error"],
    ["mcp_tool_call_failed", "mcp_error"],
  ])("maps connection failure %s", (code, expected) => {
    expect(errorCode(new McpConnectionError(code), new AbortController().signal)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "SYNTHETIC_SERVER_ERROR",
    new Error("SYNTHETIC_SERVER_ERROR"),
    {
      code: "mcp_auth_required",
    },
  ])("does not trust arbitrary error values: %j", (error) => {
    expect(errorCode(error, new AbortController().signal)).toBe("mcp_error");
  });

  it("prioritizes cancellation over a protocol failure", () => {
    const controller = new AbortController();
    controller.abort();
    expect(errorCode(new McpProtocolError(-32602), controller.signal)).toBe("mcp_timeout");
  });
});
