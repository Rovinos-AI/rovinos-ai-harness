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
export { Principal } from "./principal.js";
export { ApprovalPayloadSchema, type ApprovalPayload } from "./approval-payload.js";
export { AppContentEnvelopeSchema, type AppContentEnvelope } from "./app-content.js";
export {
  FormSchema,
  InputRequestSchema,
  InputResponseSchema,
  formSchemaToZod,
  type InputRequest,
  type InputResponse,
} from "./human-input.js";
export {
  ApprovalAppGetRequestSchema,
  ApprovalAppInputSchema,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
  type ApprovalAppGetRequest,
  type ApprovalAppInput,
} from "./approval-tools.js";
export { ToolBinaryPayloadSchema, type ToolBinaryPayload } from "./tool-binary.js";
export {
  createVerdictSchema,
  VerdictCriterionSchema,
  VerdictSchema,
  type Verdict,
} from "./verdict.js";
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
  EVENT_SCHEMA_VERSIONS,
  RawEventEnvelopeSchema,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_UPCASTERS,
  UPCASTERS,
  upcastEvent,
  upcastSnapshot,
  type EventUpcaster,
  type EventUpcasterMap,
} from "./event-versions.js";
export {
  EVENT_FIELD_CLASS,
  joinEvent,
  splitEvent,
  type EventFieldClass,
} from "./classification.js";
export {
  APP_TELEMETRY_TOOL_NAME,
  Code,
  Id,
  Pseudonym,
  Sha256Hex,
  SpanId,
  TraceId,
  Traceparent,
  UNREGISTERED_TOOL_ID,
  WorkspaceRef,
} from "./primitives.js";
export { isRegexSafePattern } from "./regex-safety.js";
export { AppSpanSchema, type AppSpan } from "./app-span.js";
export {
  RunConsoleDetailSchema,
  RunConsoleListSchema,
  RunConsoleRunSchema,
  type RunConsoleDetail,
  type RunConsoleList,
  type RunConsoleRun,
} from "./run-console.js";
export {
  InputSummarySchema,
  InputListResultSchema,
  InputShowResultSchema,
  InputResolveResultSchema,
  type InputSummary,
} from "./cli/inputs.js";
export { SecretRefSchema, type SecretRef } from "./secret-ref.js";
export { KeyVersionConfigSchema, KeysConfigSchema, type KeysConfig } from "./config/keys.js";
export { isSecretKeyName } from "./secret-key-name.js";
export {
  DestinationSchema,
  PII_BUILTIN_ENTITIES,
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
export { VaultValueEntrySchema, type VaultValueEntry } from "./vault-value-entry.js";
export {
  RunBudgetsSchema,
  RunConfigSchema,
  RunContinuationsSchema,
  type RunConfig,
} from "./config/run.js";
export { RunResumePolicySchema } from "./config/run.js";
export {
  StoreConfigSchema,
  StoreRetentionConfigSchema,
  type StoreConfig,
  type StoreRetentionConfig,
} from "./config/store.js";
export { VaultConfigSchema, type VaultConfig } from "./config/vault.js";
export { DeploymentConfigSchema, type DeploymentConfig } from "./config/deployment.js";
export {
  ModelEnforcementConfigSchema,
  ModelPricingRateSchema,
  ModelProviderQuirksSchema,
  ModelRetryConfigSchema,
  ModelProviderConfigSchema,
  ModelRoutingConfigSchema,
  ModelsConfigSchema,
  type ModelEnforcementConfig,
  type ModelPricingRate,
  type ModelProviderConfig,
  type ModelProviderQuirks,
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
export {
  QuotaConfigSchema,
  QuotaMatchSchema,
  QuotasConfigSchema,
  type QuotaConfig,
  type QuotasConfig,
} from "./config/quotas.js";
export {
  ServerConfigSchema,
  ServersConfigSchema,
  type ServerConfig,
  type ServersConfig,
} from "./config/servers.js";
export {
  ApprovalConfigSchema,
  ApprovalNotifierConfigSchema,
  PolicyConfigSchema,
  type PolicyConfig,
} from "./config/policy.js";
export {
  JsonPointerSchema,
  PiiConfigSchema,
  PiiDetokenizeRuleSchema,
  PiiPresidioConfigSchema,
  type JsonPointer,
  type PiiConfig,
  type PiiDetokenizeRule,
  type PiiPresidioConfig,
} from "./config/pii.js";
export {
  CustomDetectorSchema,
  DetectionSchema,
  DetectorTextSchema,
  parseTokenType,
  TOKEN_TYPE_MAX_LENGTH,
  type CustomDetector,
  type Detection,
} from "./pii-detection.js";
export { TelemetryConfigSchema, type TelemetryConfig } from "./config/telemetry.js";
export {
  ElicitationConfigSchema,
  ServerElicitationConfigSchema,
  type ElicitationConfig,
  type ServerElicitationConfig,
} from "./config/elicitation.js";
export { CliConfigSchema, type CliConfig } from "./config/cli.js";
export { HostConfigSchema, type HostConfig } from "./config/host.js";
export {
  ControlPlaneAuthScopeSchema,
  ControlPlaneConfigSchema,
  type ControlPlaneAuthScope,
  type ControlPlaneConfig,
} from "./config/control-plane.js";
export {
  SandboxConfigSchema,
  SandboxEgressAllowEntrySchema,
  SandboxEgressAllowlistSchema,
  SandboxEgressConfigSchema,
  SandboxRunnerUrlSchema,
} from "./config/sandbox.js";
export { ServeResultSchema, type ServeResult } from "./cli/serve.js";
export { ContextInspectionSchema, type ContextInspection } from "./cli/context.js";
export {
  StoreMigrateResultSchema,
  StorePurgeResultSchema,
  type StoreMigrateResult,
  type StorePurgeResult,
} from "./cli/store.js";
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
  PolicyLintResultSchema,
  PolicyTestCallSchema,
  PolicyTestCaseResultSchema,
  PolicyTestExpectationSchema,
  PolicyTestResultSchema,
  type PolicyLintResult,
  type PolicyTestCall,
  type PolicyTestExpectation,
  type PolicyTestResult,
} from "./cli/policy.js";
export {
  InspectEventSchema,
  InspectResultSchema,
  type InspectEvent,
  type InspectResult,
} from "./cli/inspect.js";
export {
  ApprovalListResultSchema,
  ApprovalResolveResultSchema,
  ApprovalShowResultSchema,
  ApprovalSweepResultSchema,
  ApprovalSummarySchema,
  type ApprovalListResult,
  type ApprovalResolveResult,
  type ApprovalShowResult,
  type ApprovalSweepResult,
  type ApprovalSummary,
} from "./cli/approvals.js";
export {
  DoctorCheckResultSchema,
  DoctorCheckStatusSchema,
  DoctorResultsSchema,
  DoctorStatusSchema,
  type DoctorCheckResult,
  type DoctorCheckStatus,
  type DoctorStatus,
} from "./cli/doctor.js";
export {
  KeyGenerateResultSchema,
  KeyRetireResultSchema,
  KeyRotationResultSchema,
  type KeyGenerateResult,
  type KeyRetireResult,
  type KeyRotationResult,
} from "./cli/keys.js";
export {
  PiiExplainResultSchema,
  PiiPolicyExplanationRowSchema,
  type PiiExplainResult,
  type PiiPolicyExplanationRow,
} from "./cli/pii.js";
export {
  ServersCheckResultSchema,
  ServersCheckServerResultSchema,
  type ServersCheckResult,
  type ServersCheckServerResult,
} from "./cli/servers.js";
export { eventSamples, FakeClock, SequentialIdGenerator } from "./testing.js";

/** The current harness version. */
export const HARNESS_VERSION = "0.0.0";
