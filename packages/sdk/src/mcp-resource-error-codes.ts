// SPDX-License-Identifier: Apache-2.0
/** Closed MCP resource failure codes surfaced by the SDK. */
export type SdkMcpResourceOperationErrorCode =
  | "mcp_read_resource_failed"
  | "mcp_resource_access_denied"
  | "mcp_resource_content_unsupported"
  | "mcp_resource_grant_invalid"
  | "mcp_resource_request_too_large"
  | "mcp_resource_subscription_unavailable"
  | "mcp_resource_timeout"
  | "mcp_resource_tokenization_failed"
  | "mcp_resource_uri_invalid"
  | "mcp_resources_changed"
  | "mcp_resources_unavailable"
  | "mcp_too_many_resources";
