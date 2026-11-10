// SPDX-License-Identifier: Apache-2.0
export { attr, getAttrMeta, isSafeAttr, type AttrMeta } from "./attr.js";
export {
  SpanRegistryError,
  TelemetryMetricsConfigError,
  TelemetrySdkError,
  type SpanRegistryIssue,
} from "./errors.js";
export { LogRegistryError } from "./log-registry.js";
export {
  createLogger,
  NoopLogger,
  type CreateLoggerOptions,
  type Logger,
  type LoggerLevel,
  type LogFields,
  type LogValue,
} from "./logger.js";
export { POLICY_VERSION } from "./generated/policy-version.js";
export {
  assertSinkPolicies,
  SinkPolicyError,
  type AssertSinkPoliciesOptions,
  type SinkPolicyConfig,
} from "./sinks/policy.js";
export {
  SafeEvent,
  toSafeEvent,
  type SafeEvent as SafeEventType,
  type SafeEventPseudonyms,
} from "./safe-event.js";
export { AllowlistSpanProcessor, sanitizeSpan } from "./processors/allowlist-span-processor.js";
export { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
export {
  defineLogRecord,
  listLogDefinitions,
  lookupLogDefinition,
  type LogRecordDefinition,
  type LogRecordShape,
} from "./log-registry.js";
export {
  emitSafeEvent,
  emitSafeEventToDefaultLogger,
  emitKeysRotated,
  emitVaultMarkTerminalFailed,
  emitPricingMissing,
  emitPricingCacheMissing,
  safeEventLogAttributeMap,
} from "./safe-event-logs.js";
export { emitApprovalAppAudit } from "./approval-app-audit.js";
export { emitControlPlaneAudit } from "./control-plane-audit.js";
export {
  APPROVAL_DECISIONS,
  countCompletedRun,
  countDroppedTelemetry,
  countHostAppRejected,
  countHostAppSpansAccepted,
  countModelUsage,
  countMcpDiscoveryFailed,
  countMcpInputRequest,
  countRateLimitDenied,
  countRateLimitDegraded,
  countPiiBlobHit,
  countPiiDetectorDegraded,
  countPolicyDecision,
  countQuotaRejection,
  countToolCall,
  countWorkerJob,
  METRIC_ALLOWLIST,
  recordApprovalWait,
  recordModelLatency,
  recordWorkerQueueLag,
  RUN_COMPLETION_OUTCOMES,
  TOOL_CALL_OUTCOMES,
  type ApprovalDecision,
  type HostAppRejectedReason,
  type McpInputRequestOutcome,
  MCP_INPUT_REQUEST_OUTCOMES,
  type PolicyDecision,
  POLICY_DECISIONS,
  type WorkerJobOutcome,
  type RateLimitBackend,
  type RateLimitKeyKind,
  type RunCompletionOutcome,
  type ToolCallOutcome,
  WORKER_JOB_OUTCOMES,
  RATE_LIMIT_BACKENDS,
  RATE_LIMIT_KEY_KINDS,
  type TelemetryDropReason,
} from "./metrics.js";
export {
  __resetRegistryForTests,
  defineSpan,
  defineSemconvSpan,
  ensureTracingFallback,
  listSpanDefinitions,
  lookupSpanDefinition,
  setActiveSpanAttribute,
  safeRecordError,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanOwnerTask,
  type SpanShape,
} from "./registry.js";
export {
  MCP_METHOD_NAME,
  SEMCONV_ATTRIBUTE_NAMES,
  SEMCONV_SPAN_NAMES,
  SEMCONV_STABILITY_OPT_IN,
  SEMCONV_VERSION,
} from "./semconv.js";
export {
  RunValueSet,
  VaultRunView,
  type VaultRunReader,
  type VaultRunViewOptions,
} from "./sentinel/run-values.js";
export { normalizeForScan, variantsOf } from "./sentinel/variants.js";
export { ActiveRuns, activeRuns, type ActiveRunsOptions } from "./sentinel/active-runs.js";
export {
  assertSentinelGate,
  SentinelGate,
  SentinelGateInputSchema,
  SentinelGateResultSchema,
  SentinelRequiredError,
  type SentinelGateInput,
  type SentinelGateOptions,
  type SentinelGateResult,
  type SentinelMatcherLike,
} from "./sentinel/gate.js";
export {
  SentinelTripSchema,
  TripQueue,
  sentinelTripQueue,
  type SentinelTrip,
} from "./sentinel/trips.js";
export { emitSentinelTrip } from "./safe-event-logs.js";
export {
  createTelemetrySdk,
  forceFlushTelemetry,
  type TelemetrySdk,
  type TelemetrySdkOptions,
} from "./sdk.js";
export { initializeTelemetryMetrics, type TelemetryMetricsLifecycle } from "./metrics-sdk.js";
