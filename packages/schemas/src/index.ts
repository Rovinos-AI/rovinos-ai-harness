// SPDX-License-Identifier: Apache-2.0
export {
  ContractError,
  parseJson,
  parseYaml,
  safeParseJson,
  type ContractIssue,
  type ParseOptions,
  type SafeParseJsonResult,
} from "./parse.js";
export { HarnessError } from "./errors.js";
export {
  compileJsonSchema,
  type CompileJsonSchemaOptions,
  type JsonSchemaValidator,
} from "./json-schema.js";
export { JsonValue } from "./json.js";
export { ToolBinaryPayloadSchema, type ToolBinaryPayload } from "./tool-binary.js";
export {
  MessageSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  ModelRefSchema,
  ModelUsageSchema,
  PartSchema,
  ToolSpecSchema,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ModelRef,
  type ModelUsage,
  type Part,
  type ToolSpec,
} from "./messages.js";
export { CapabilitiesSchema, lookupCapabilities, type Capabilities } from "./capabilities.js";
export {
  Event,
  EventEnvelopeSchema,
  EventSchema,
  type EventType,
  type NewEvent,
  type PayloadKeys,
  RunStatus,
} from "./events.js";
export {
  EVENT_FIELD_CLASS,
  joinEvent,
  splitEvent,
  type EventFieldClass,
} from "./classification.js";
export { Code, Id, Sha256Hex, SpanId, TraceId, Traceparent, WorkspaceRef } from "./primitives.js";
export { SecretRefSchema, type SecretRef } from "./secret-ref.js";
export {
  DestinationSchema,
  PiiActionSchema,
  PiiBoundarySchema,
  PiiEntitySchema,
  PiiPolicySchema,
  PiiRuleSchema,
  type Destination,
  type PiiAction,
  type PiiBoundary,
  type PiiEntity,
  type PiiPolicy,
  type PiiRule,
} from "./pii-policy.js";
export {
  PiiActionSummarySchema,
  toPiiActionEventPayload,
  type PiiActionSummary,
} from "./pii-action-summary.js";
export { SnapshotSchema, type Snapshot } from "./snapshot.js";
export { KEY_PROVIDER_KEY_BYTES, type KeyProvider } from "./key-provider.js";
export { RunConfigSchema, RunContinuationsSchema, type RunConfig } from "./config/run.js";
export { RunResumePolicySchema } from "./config/run.js";
export { StoreConfigSchema } from "./config/store.js";
export {
  ModelEnforcementConfigSchema,
  ModelRetryConfigSchema,
  ModelProviderConfigSchema,
  ModelRoutingConfigSchema,
  ModelsConfigSchema,
  type ModelEnforcementConfig,
  type ModelProviderConfig,
  type ModelRoutingConfig,
  type ModelRetryConfig,
  type ModelsConfig,
} from "./config/models.js";
export {
  RoleBudgetsSchema,
  RoleConfigSchema,
  RoleSystemPromptSchema,
  RoleToolPatternSchema,
  RolesConfigSchema,
  type RoleBudgets,
  type RoleConfig,
  type RoleToolPattern,
  type RolesConfig,
} from "./config/roles.js";
export { ServerConfigSchema } from "./config/servers.js";
export { PolicyConfigSchema } from "./config/policy.js";
export {
  JsonPointerSchema,
  PiiConfigSchema,
  PiiDetokenizeRuleSchema,
  type JsonPointer,
  type PiiConfig,
  type PiiDetokenizeRule,
} from "./config/pii.js";
export {
  CustomDetectorSchema,
  DetectionSchema,
  DetectorTextSchema,
  TOKEN_TYPE_MAX_LENGTH,
  type CustomDetector,
  type Detection,
} from "./pii-detection.js";
export { TelemetryConfigSchema, type TelemetryConfig } from "./config/telemetry.js";
export { SandboxConfigSchema } from "./config/sandbox.js";
export { ServeResultSchema, type ServeResult } from "./cli/serve.js";
export { ContextInspectionSchema, type ContextInspection } from "./cli/context.js";
export {
  FakeModelCompletionSchema,
  FakeModelScriptSchema,
  RunInputSchema,
  RunResultSchema,
  type FakeModelCompletion,
  type FakeModelScript,
  type RunInput,
  type RunResult,
} from "./cli/run.js";
export {
  InspectEventSchema,
  InspectResultSchema,
  type InspectEvent,
  type InspectResult,
} from "./cli/inspect.js";
export { eventSamples, FakeClock, SequentialIdGenerator } from "./testing.js";

/** The current harness version. */
export const HARNESS_VERSION = "0.0.0";
