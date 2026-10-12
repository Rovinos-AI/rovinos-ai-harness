// SPDX-License-Identifier: Apache-2.0
export { attr, getAttrMeta, isSafeAttr, type AttrMeta } from "./attr.js";
export { SpanRegistryError, type SpanRegistryIssue } from "./errors.js";
export { LogRegistryError } from "./log-registry.js";
export { SafeEvent, toSafeEvent, type SafeEvent as SafeEventType } from "./safe-event.js";
export { AllowlistSpanProcessor, sanitizeSpan } from "./processors/allowlist-span-processor.js";
export { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
export {
  defineLogRecord,
  listLogDefinitions,
  lookupLogDefinition,
  type LogRecordDefinition,
  type LogRecordShape,
} from "./log-registry.js";
export { emitSafeEvent, safeEventLogAttributeMap } from "./safe-event-logs.js";
export {
  __resetRegistryForTests,
  defineSpan,
  defineSemconvSpan,
  ensureTracingFallback,
  listSpanDefinitions,
  lookupSpanDefinition,
  setActiveSpanAttribute,
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
export { ActiveRuns, activeRuns, type ActiveRunsOptions } from "./sentinel/active-runs.js";
export {
  assertSentinelGate,
  SentinelGate,
  SentinelGateInputSchema,
  SentinelGateResultSchema,
  SentinelRequiredError,
  SentinelTripSchema,
  type SentinelGateInput,
  type SentinelGateOptions,
  type SentinelGateResult,
  type SentinelMatcherLike,
  type SentinelTrip,
} from "./sentinel/gate.js";
export { createTelemetrySdk, type TelemetrySdk, type TelemetrySdkOptions } from "./sdk.js";
