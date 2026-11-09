// SPDX-License-Identifier: Apache-2.0
import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
} from "@opentelemetry/api";
import { Code, type Code as CodeType, type ModelUsage } from "@rovinos/schemas";
import { isValidModelUsage } from "./metric-validation.js";
import type {
  HostAppRejectedAttributes,
  HostAppRejectedReason,
  METRIC_ALLOWLIST,
  McpInputRequestAttributes,
  McpInputRequestOutcome,
  ModelUsageAttributes,
  PolicyDecision,
  PolicyDecisionAttributes,
  QuotaRejectionAttributes,
  RateLimitBackend,
  RateLimitKeyKind,
  TelemetryDropAttributes,
  TelemetryDropReason,
  WorkerJobAttributes,
  WorkerJobOutcome,
} from "./metric-attributes.js";
import { safelyRecordMetric } from "./metric-safety.js";

type NoMetricAttributes = Readonly<Record<string, never>>;
export {
  HOST_APP_REJECTED_REASONS,
  METRIC_ALLOWLIST,
  MCP_INPUT_REQUEST_OUTCOMES,
  POLICY_DECISIONS,
  RATE_LIMIT_BACKENDS,
  RATE_LIMIT_KEY_KINDS,
  TELEMETRY_DROP_REASONS,
  TELEMETRY_METRIC_STRING_ATTRIBUTES,
  WORKER_JOB_OUTCOMES,
} from "./metric-attributes.js";
export type {
  HostAppRejectedReason,
  McpInputRequestOutcome,
  PolicyDecision,
  RateLimitBackend,
  RateLimitKeyKind,
  TelemetryDropReason,
  WorkerJobOutcome,
} from "./metric-attributes.js";

let droppedCounter: Counter<TelemetryDropAttributes> | undefined;
let hostAppRejectedCounter: Counter<HostAppRejectedAttributes> | undefined;
let policyDecisionsCounter: Counter<PolicyDecisionAttributes> | undefined;
let piiBlobHitCounter: Counter<NoMetricAttributes> | undefined;
let piiDetectorDegradedCounter: Counter<NoMetricAttributes> | undefined;
let hostAppSpansAcceptedCounter: Counter<NoMetricAttributes> | undefined;
let skippedShortValuesCounter: Counter<NoMetricAttributes> | undefined;
let scopeReducedCounter: Counter<NoMetricAttributes> | undefined;
let modelTokensCounter: Counter<ModelUsageAttributes> | undefined;
let modelCostCounter: Counter<ModelUsageAttributes> | undefined;
let modelCacheReadCounter: Counter<ModelUsageAttributes> | undefined;
let modelCacheWriteCounter: Counter<ModelUsageAttributes> | undefined;
let mcpDiscoveryFailedCounter: Counter<NoMetricAttributes> | undefined;
let quotaRejectionsCounter: Counter<QuotaRejectionAttributes> | undefined;
let mcpInputRequestsCounter: Counter<McpInputRequestAttributes> | undefined;
let workerJobsCounter: Counter<WorkerJobAttributes> | undefined;
let rateLimitDeniedCounter: Counter<QuotaRejectionAttributes> | undefined;
let rateLimitDegradedCounter: Counter<QuotaRejectionAttributes> | undefined;
let workerQueueLagHistogram: Histogram<NoMetricAttributes> | undefined;
let telemetryMeterProvider: MeterProvider | undefined;

function getTelemetryMeter(): Meter {
  return (
    telemetryMeterProvider?.getMeter("@rovinos/telemetry") ?? metrics.getMeter("@rovinos/telemetry")
  );
}

/** Selects the harness-owned provider and invalidates cached instruments when ownership changes. */
export function selectTelemetryMeterProvider(provider: MeterProvider | undefined): void {
  if (telemetryMeterProvider === provider) {
    return;
  }
  telemetryMeterProvider = provider;
  droppedCounter = undefined;
  hostAppRejectedCounter = undefined;
  policyDecisionsCounter = undefined;
  piiBlobHitCounter = undefined;
  piiDetectorDegradedCounter = undefined;
  hostAppSpansAcceptedCounter = undefined;
  skippedShortValuesCounter = undefined;
  scopeReducedCounter = undefined;
  modelTokensCounter = undefined;
  modelCostCounter = undefined;
  modelCacheReadCounter = undefined;
  modelCacheWriteCounter = undefined;
  mcpDiscoveryFailedCounter = undefined;
  quotaRejectionsCounter = undefined;
  mcpInputRequestsCounter = undefined;
  workerJobsCounter = undefined;
  rateLimitDeniedCounter = undefined;
  rateLimitDegradedCounter = undefined;
  workerQueueLagHistogram = undefined;
}

function createCounter<TAttributes extends Attributes>(
  name: keyof typeof METRIC_ALLOWLIST,
  factory: (meter: Meter, name: keyof typeof METRIC_ALLOWLIST) => Counter<TAttributes>,
): Counter<TAttributes> {
  return factory(getTelemetryMeter(), name);
}

function createMetricHistogram(name: keyof typeof METRIC_ALLOWLIST): Histogram<NoMetricAttributes> {
  return getTelemetryMeter().createHistogram<NoMetricAttributes>(name);
}

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= createCounter<TelemetryDropAttributes>(
    "harness.telemetry.dropped",
    (meter, name) => meter.createCounter<TelemetryDropAttributes>(name),
  );
  return droppedCounter;
}

function getHostAppRejectedCounter(): Counter<HostAppRejectedAttributes> {
  hostAppRejectedCounter ??= createCounter<HostAppRejectedAttributes>(
    "harness.host.app_rejected",
    (meter, name) => meter.createCounter<HostAppRejectedAttributes>(name),
  );
  return hostAppRejectedCounter;
}

function getPolicyDecisionsCounter(): Counter<PolicyDecisionAttributes> {
  policyDecisionsCounter ??= createCounter<PolicyDecisionAttributes>(
    "harness.policy.decisions",
    (meter, name) => meter.createCounter<PolicyDecisionAttributes>(name),
  );
  return policyDecisionsCounter;
}

function getPiiBlobHitCounter(): Counter<NoMetricAttributes> {
  piiBlobHitCounter ??= createCounter<NoMetricAttributes>("harness.pii.blob_hit", (meter, name) =>
    meter.createCounter<NoMetricAttributes>(name),
  );
  return piiBlobHitCounter;
}

function getPiiDetectorDegradedCounter(): Counter<NoMetricAttributes> {
  piiDetectorDegradedCounter ??= createCounter<NoMetricAttributes>(
    "harness.pii.detector_degraded",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return piiDetectorDegradedCounter;
}

function getHostAppSpansAcceptedCounter(): Counter<NoMetricAttributes> {
  hostAppSpansAcceptedCounter ??= createCounter<NoMetricAttributes>(
    "harness.host.app_spans_accepted",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return hostAppSpansAcceptedCounter;
}

function getSkippedShortValuesCounter(): Counter<NoMetricAttributes> {
  skippedShortValuesCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.short_values_skipped",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter<NoMetricAttributes> {
  scopeReducedCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.scope_reduced",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return scopeReducedCounter;
}

function getModelTokensCounter(): Counter<ModelUsageAttributes> {
  modelTokensCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelTokensCounter;
}

function getModelCostCounter(): Counter<ModelUsageAttributes> {
  modelCostCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cost_micros",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCostCounter;
}

function getModelCacheReadCounter(): Counter<ModelUsageAttributes> {
  modelCacheReadCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cache_read_tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCacheReadCounter;
}

function getModelCacheWriteCounter(): Counter<ModelUsageAttributes> {
  modelCacheWriteCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cache_write_tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCacheWriteCounter;
}

function getMcpDiscoveryFailedCounter(): Counter<NoMetricAttributes> {
  mcpDiscoveryFailedCounter ??= createCounter<NoMetricAttributes>(
    "harness.mcp.discovery_failed",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return mcpDiscoveryFailedCounter;
}

function getQuotaRejectionsCounter(): Counter<QuotaRejectionAttributes> {
  quotaRejectionsCounter ??= createCounter<QuotaRejectionAttributes>(
    "harness.quota.rejections",
    (meter, name) => meter.createCounter<QuotaRejectionAttributes>(name),
  );
  return quotaRejectionsCounter;
}

function getMcpInputRequestsCounter(): Counter<McpInputRequestAttributes> {
  mcpInputRequestsCounter ??= createCounter<McpInputRequestAttributes>(
    "harness.mcp.input_requests",
    (meter, name) => meter.createCounter<McpInputRequestAttributes>(name),
  );
  return mcpInputRequestsCounter;
}

/** Counts one quota rejection using the configured quota's bounded code. */
export function countQuotaRejection(quotaId: CodeType): void {
  safelyRecordMetric(() => {
    getQuotaRejectionsCounter().add(1, { "harness.quota.id": Code.parse(quotaId) });
  });
}

function getWorkerJobsCounter(): Counter<WorkerJobAttributes> {
  workerJobsCounter ??= createCounter<WorkerJobAttributes>("harness.worker.jobs", (meter, name) =>
    meter.createCounter<WorkerJobAttributes>(name),
  );
  return workerJobsCounter;
}

function getRateLimitDeniedCounter(): Counter<QuotaRejectionAttributes> {
  rateLimitDeniedCounter ??= createCounter<QuotaRejectionAttributes>(
    "harness.rate_limit.denied",
    (meter, name) => meter.createCounter<QuotaRejectionAttributes>(name),
  );
  return rateLimitDeniedCounter;
}

function getRateLimitDegradedCounter(): Counter<QuotaRejectionAttributes> {
  rateLimitDegradedCounter ??= createCounter<QuotaRejectionAttributes>(
    "harness.rate_limit.degraded",
    (meter, name) => meter.createCounter<QuotaRejectionAttributes>(name),
  );
  return rateLimitDegradedCounter;
}

/** Counts one denied rate-limit request without exporting its key. */
export function countRateLimitDenied(keyKind: RateLimitKeyKind): void {
  safelyRecordMetric(() => {
    getRateLimitDeniedCounter().add(1, { "harness.rate_limit.denied.key_kind": keyKind });
  });
}

/** Counts use of an unavailable shared rate-limit backend. */
export function countRateLimitDegraded(backend: RateLimitBackend): void {
  safelyRecordMetric(() => {
    getRateLimitDegradedCounter().add(1, { "harness.rate_limit.degraded.backend": backend });
  });
}

function getWorkerQueueLagHistogram(): Histogram<NoMetricAttributes> {
  workerQueueLagHistogram ??= createMetricHistogram("harness.worker.queue_lag_ms");
  return workerQueueLagHistogram;
}

/** Counts a telemetry drop using its bounded reason code. */
export function countDroppedTelemetry(reason: TelemetryDropReason): void {
  safelyRecordMetric(() => {
    getDroppedCounter().add(1, { "harness.telemetry.dropped.reason": reason });
  });
}

/** Counts an app tool rejection with its bounded host reason code. */
export function countHostAppRejected(reason: HostAppRejectedReason): void {
  safelyRecordMetric(() => {
    getHostAppRejectedCounter().add(1, { "harness.host.app_rejected.reason": reason });
  });
}

/** Counts one policy decision using its bounded outcome. */
export function countPolicyDecision(decision: PolicyDecision): void {
  safelyRecordMetric(() => {
    getPolicyDecisionsCounter().add(1, { "harness.policy.decision": decision });
  });
}

/** Counts one opaque provider blob that contains detected sensitive content. */
export function countPiiBlobHit(): void {
  safelyRecordMetric(() => {
    getPiiBlobHitCounter().add(1);
  });
}

/** Counts one PII detection run that continued without its configured async detector. */
export function countPiiDetectorDegraded(): void {
  safelyRecordMetric(() => {
    getPiiDetectorDegradedCounter().add(1);
  });
}

/** Counts accepted app spans without high-cardinality attributes. */
export function countHostAppSpansAccepted(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return;
  }
  safelyRecordMetric(() => {
    getHostAppSpansAcceptedCounter().add(count);
  });
}

/** Counts values excluded from a run's sentinel set without metric attributes. */
export function countSkippedShortValues(count: number): void {
  safelyRecordMetric(() => {
    getSkippedShortValuesCounter().add(count);
  });
}

/** Counts when a global scan uses per-run matchers instead of a combined matcher. */
export function countSentinelScopeReduced(): void {
  safelyRecordMetric(() => {
    getScopeReducedCounter().add(1);
  });
}

/** Counts total input and output tokens and optional cost for one provider/model. */
export function countModelUsage(
  usage: Pick<
    ModelUsage,
    "inputTokens" | "outputTokens" | "costMicros" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  provider: string,
  model: string,
): void {
  if (!isValidModelUsage(usage)) {
    return;
  }
  safelyRecordMetric(() => {
    const attributes: ModelUsageAttributes = {
      "harness.model.provider": Code.parse(provider),
      "harness.model.name": Code.parse(model),
    };
    getModelTokensCounter().add(usage.inputTokens + usage.outputTokens, attributes);
    if (usage.cacheReadTokens !== undefined) {
      getModelCacheReadCounter().add(usage.cacheReadTokens, attributes);
    }
    if (usage.cacheWriteTokens !== undefined) {
      getModelCacheWriteCounter().add(usage.cacheWriteTokens, attributes);
    }
    if (usage.costMicros !== undefined) {
      getModelCostCounter().add(usage.costMicros, attributes);
    }
  });
}

/** Counts an MCP tool-discovery failure without server identifiers. */
export function countMcpDiscoveryFailed(): void {
  safelyRecordMetric(() => {
    getMcpDiscoveryFailedCounter().add(1);
  });
}

/** Counts an MCP input-request outcome without server identifiers or request content. */
export function countMcpInputRequest(outcome: McpInputRequestOutcome): void {
  safelyRecordMetric(() => {
    getMcpInputRequestsCounter().add(1, { "harness.mcp.input_requests.outcome": outcome });
  });
}

/** Counts a worker job using a bounded outcome and no identifiers. */
export function countWorkerJob(outcome: WorkerJobOutcome): void {
  safelyRecordMetric(() => {
    getWorkerJobsCounter().add(1, { "harness.worker.jobs.outcome": outcome });
  });
}

/** Records queue delay without identifiers or other attributes. */
export function recordWorkerQueueLag(lagMs: number): void {
  if (!Number.isFinite(lagMs) || lagMs < 0) {
    return;
  }
  safelyRecordMetric(() => {
    getWorkerQueueLagHistogram().record(lagMs);
  });
}
