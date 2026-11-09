// SPDX-License-Identifier: Apache-2.0
/**
 * Creates a validated SDK around the harness runtime.
 *
 * @param options - Validated config or config path and optional runtime adapters.
 * @returns Programmatic run, metadata, approval, and subscription operations.
 */
export { createHarness } from "./harness.js";
export {
  inspectMcpServer,
  registerMcpServer,
  selectMcpTools,
  McpCatalogInspectionSchema,
  InspectMcpServerOptionsSchema,
  McpToolSelectionSchema,
  type InspectMcpServerOptions,
  type McpCatalogInspection,
  type McpServerConfig,
  type McpToolSelection,
  type McpToolSelectionResult,
} from "./mcp-onboarding.js";
export { HarnessConfigSchema, type HarnessConfig } from "@rovinos/config";
export { Principal as PrincipalSchema } from "@rovinos/schemas";
export type { Principal } from "@rovinos/schemas";
export {
  SdkError,
  type ApprovalDecision,
  type AnswerInputOptions,
  type CancelRunResult,
  type ContinueRunOptions,
  type CreateHarnessOptions,
  type GetRunContentOptions,
  type Harness,
  type HarnessOverrides,
  InputResolutionResultSchema,
  type InputResolutionResult,
  type ListRunsFilter,
  type ResolveApprovalOptions,
  type RunContent,
  type RunPage,
  type RunId,
  type RunStartResult,
  type RunSummary,
  type RunView,
  type SdkMcpConnectionErrorCode,
  type StartRunOptions,
  type WatchOptions,
} from "./types.js";
export type { SafeEvent } from "@rovinos/telemetry";
