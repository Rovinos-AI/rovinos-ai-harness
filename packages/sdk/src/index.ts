// SPDX-License-Identifier: Apache-2.0
/**
 * Creates a validated SDK around the harness runtime.
 *
 * @param options - Validated config or config path and optional runtime adapters.
 * @returns Programmatic run, metadata, approval, and subscription operations.
 */
export { createHarness } from "./harness.js";
export {
  ExtensionCapabilitySchema,
  ExtensionCapabilityStatusSchema,
  ExtensionDefinitionSchema,
  ExtensionError,
  ExtensionGrantSchema,
  ExtensionGrantRevocationSchema,
  ExtensionManifestSchema,
  ExtensionRegistrationSchema,
  ExtensionRegistrationStatusSchema,
  SDK_VERSION,
  defineTool,
} from "./extensions.js";
export type {
  ExtensionCapability,
  ExtensionCapabilityStatus,
  ExtensionContributions,
  ExtensionDefinition,
  ExtensionGrant,
  ExtensionGrantRevocation,
  ExtensionManifest,
  ExtensionRegistration,
  ExtensionRegistrationStatus,
  ExtensionToolDefinition,
  ToolInvocationContext,
} from "./extensions.js";
export {
  Code as CodeSchema,
  Id as IdSchema,
  JsonValue as JsonValueSchema,
  ModelRefSchema,
  ModelRequestSchema,
  ModelUsageSchema,
  PartSchema,
} from "@rovinos/schemas";
export type { Code, Id, JsonValue, ModelRequest, ModelUsage, Part } from "@rovinos/schemas";
export { ProviderDeltaSchema, ProviderResultSchema } from "@rovinos/models";
export type {
  ProviderAdapter,
  ProviderContext,
  ProviderDelta,
  ProviderResult,
} from "@rovinos/models";
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
  type StartRunOptions,
  type WatchOptions,
} from "./types.js";
export type { SafeEvent } from "@rovinos/telemetry";
