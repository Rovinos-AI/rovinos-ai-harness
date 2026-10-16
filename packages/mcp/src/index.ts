// SPDX-License-Identifier: Apache-2.0
export {
  McpConnection,
  McpConnectionError,
  type McpConnectionDependencies,
  type McpConnectionErrorCode,
  type McpConnectionState,
  type McpTool,
} from "./connection.js";
export { McpProtocolError } from "./errors.js";
export {
  McpToolPort,
  type McpToolCall,
  type McpToolCallContext,
  type McpToolExecutionResult,
  type McpToolPortDependencies,
} from "./tool-port.js";
export {
  McpPool,
  McpPoolError,
  createServersAuthorizedCheck,
  createServersReachableChecks,
  type McpServerState,
  type ServersReachableCheck,
  type ServersReachableCheckContext,
} from "./pool.js";
export {
  McpAuthRequiredError,
  McpOAuthProvider,
  withOAuthWarningsRedacted,
  type McpOAuthProviderOptions,
} from "./oauth/provider.js";
export {
  startMcpOAuthLogin,
  type McpOAuthLoginOptions,
  type McpOAuthLoginSession,
} from "./oauth/login.js";
export {
  OAuthTokenStore,
  OAuthTokenStoreError,
  OAuthCredentialRecordSchema,
  type OAuthCredentialRecord,
} from "./oauth/token-store.js";
export {
  createMcpTransport,
  type McpLogger,
  type McpLogEvent,
  type McpTransportDependencies,
} from "./transports.js";
export {
  ToolRegistry,
  ToolRegistryError,
  normalizeToolId,
  type RejectedTool,
  type ResolvedTool,
  type ToolRegistryServer,
} from "./registry.js";
export { UNREGISTERED_TOOL_ID } from "./registry.js";
export { buildRequestMeta } from "./trace-injection.js";
