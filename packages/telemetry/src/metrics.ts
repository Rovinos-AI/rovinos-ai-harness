// SPDX-License-Identifier: Apache-2.0
import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type Context,
} from "@opentelemetry/api";
import { Code, type Code as CodeType, type ModelUsage } from "@rovinos/schemas";
import { CardinalityGuard } from "./cardinality.js";
import { createLogger } from "./logger.js";
import { isValidModelUsage } from "./metric-validation.js";
import type {
  HostAppRejectedAttributes,
  HostAppRejectedReason,
  METRIC_ALLOWLIST,
  ApprovalWaitAttributes,
  McpInputRequestAttributes,
  McpInputRequestOutcome,
  ModelUsageAttributes,
  PolicyDecision,
  PolicyDecisionAttributes,
  QuotaRejectionAttributes,
  RateLimitBackend,
  RateLimitKeyKind,
  RunCompletedAttributes,
  TelemetryDropAttributes,
  TelemetryDropReason,
  ToolCallAttributes,
  WorkerJobAttributes,
  WorkerJobOutcome,
} from "./metric-attributes.js";
import { safelyRecordMetric } from "./metric-safety.js";

type NoMetricAttributes = Readonly<Record<string, never>>;
type RegisteredMetricAttributes =
  | NoMetricAttributes
  | TelemetryDropAttributes
  | HostAppRejectedAttributes
  | PolicyDecisionAttributes
  | ModelUsageAttributes
  | QuotaRejectionAttributes
  | McpInputRequestAttributes
  | WorkerJobAttributes
  | RunCompletedAttributes
  | ApprovalWaitAttributes
  | ToolCallAttributes;
type MetricName = keyof typeof METRIC_ALLOWLIST;
export {
  HOST_APP_REJECTED_REASONS,
  APPROVAL_DECISIONS,
  METRIC_ALLOWLIST,
  MCP_INPUT_REQUEST_OUTCOMES,
  POLICY_DECISIONS,
  RATE_LIMIT_BACKENDS,
  RATE_LIMIT_KEY_KINDS,
  RUN_COMPLETION_OUTCOMES,
  METRIC_ATTRIBUTE_BOUNDS,
  TELEMETRY_DROP_REASONS,
  TELEMETRY_METRIC_STRING_ATTRIBUTES,
  TOOL_CALL_OUTCOMES,
  WORKER_JOB_OUTCOMES,
} from "./metric-attributes.js";
export type {
  ApprovalDecision,
  HostAppRejectedReason,
  McpInputRequestOutcome,
  PolicyDecision,
  RateLimitBackend,
  RateLimitKeyKind,
  RunCompletionOutcome,
  TelemetryDropReason,
  ToolCallOutcome,
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
let runCompletedCounter: Counter<RunCompletedAttributes> | undefined;
let toolCallsCounter: Counter<ToolCallAttributes> | undefined;
let rateLimitDeniedCounter: Counter<QuotaRejectionAttributes> | undefined;
let rateLimitDegradedCounter: Counter<QuotaRejectionAttributes> | undefined;
let workerQueueLagHistogram: Histogram<NoMetricAttributes> | undefined;
let modelLatencyHistogram: Histogram<ModelUsageAttributes> | undefined;
let approvalWaitHistogram: Histogram<ApprovalWaitAttributes> | undefined;
let telemetryMeterProvider: MeterProvider | undefined;
const metricCardinalityLogger = createLogger({ level: "warn" });
let metricCardinalityLimit = 100;
let metricCardinalityGuard = createCardinalityGuard(metricCardinalityLimit);

function createCardinalityGuard(maxSeries: number): CardinalityGuard {
  return new CardinalityGuard({
    maxSeries,
    onDrop: () => {
      countDroppedTelemetry("cardinality");
    },
    logger: metricCardinalityLogger,
  });
}

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
  metricCardinalityGuard = createCardinalityGuard(metricCardinalityLimit);
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
  runCompletedCounter = undefined;
  toolCallsCounter = undefined;
  rateLimitDeniedCounter = undefined;
  rateLimitDegradedCounter = undefined;
  workerQueueLagHistogram = undefined;
  modelLatencyHistogram = undefined;
  approvalWaitHistogram = undefined;
}

function createCounter<TAttributes extends RegisteredMetricAttributes>(
  name: MetricName,
): Counter<TAttributes> {
  const instrument = getTelemetryMeter().createCounter<TAttributes>(name);
  return {
    add(value: number, attributes?: TAttributes, context?: Context): void {
      safelyRecordMetric(() => {
        if (metricCardinalityGuard.admit(name, attributes ?? {})) {
          if (attributes === undefined && context === undefined) {
            instrument.add(value);
          } else if (context === undefined) {
            instrument.add(value, attributes);
          } else {
            instrument.add(value, attributes, context);
          }
        }
      });
    },
  };
}

function createMetricHistogram<TAttributes extends RegisteredMetricAttributes>(
  name: MetricName,
): Histogram<TAttributes> {
  const instrument = getTelemetryMeter().createHistogram<TAttributes>(name);
  return {
    record(value: number, attributes?: TAttributes, context?: Context): void {
      safelyRecordMetric(() => {
        if (metricCardinalityGuard.admit(name, attributes ?? {})) {
          if (attributes === undefined && context === undefined) {
            instrument.record(value);
          } else if (context === undefined) {
            instrument.record(value, attributes);
          } else {
            instrument.record(value, attributes, context);
          }
        }
      });
    },
  };
}

/** Applies the validated telemetry configuration to the runtime series guard. */
export function configureMetricCardinality(maxSeries = 100): void {
  metricCardinalityLimit = maxSeries;
  metricCardinalityGuard = createCardinalityGuard(maxSeries);
}

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= createCounter<TelemetryDropAttributes>("harness.telemetry.dropped");
  return droppedCounter;
}

function getHostAppRejectedCounter(): Counter<HostAppRejectedAttributes> {
  hostAppRejectedCounter ??= createCounter<HostAppRejectedAttributes>("harness.host.app_rejected");
  return hostAppRejectedCounter;
}

function getPolicyDecisionsCounter(): Counter<PolicyDecisionAttributes> {
  policyDecisionsCounter ??= createCounter<PolicyDecisionAttributes>("harness.policy.decisions");
  return policyDecisionsCounter;
}

function getPiiBlobHitCounter(): Counter<NoMetricAttributes> {
  piiBlobHitCounter ??= createCounter<NoMetricAttributes>("harness.pii.blob_hit");
  return piiBlobHitCounter;
}

function getPiiDetectorDegradedCounter(): Counter<NoMetricAttributes> {
  piiDetectorDegradedCounter ??= createCounter<NoMetricAttributes>("harness.pii.detector_degraded");
  return piiDetectorDegradedCounter;
}

function getHostAppSpansAcceptedCounter(): Counter<NoMetricAttributes> {
  hostAppSpansAcceptedCounter ??= createCounter<NoMetricAttributes>("harness.host.app_spans_accepted");
  return hostAppSpansAcceptedCounter;
}

function getSkippedShortValuesCounter(): Counter<NoMetricAttributes> {
  skippedShortValuesCounter ??= createCounter<NoMetricAttributes>("harness.sentinel.short_values_skipped");
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter<NoMetricAttributes> {
  scopeReducedCounter ??= createCounter<NoMetricAttributes>("harness.sentinel.scope_reduced");
  return scopeReducedCounter;
}

function getModelTokensCounter(): Counter<ModelUsageAttributes> {
  modelTokensCounter ??= createCounter<ModelUsageAttributes>("harness.model.tokens");
  return modelTokensCounter;
}

function getModelCostCounter(): Counter<ModelUsageAttributes> {
  modelCostCounter ??= createCounter<ModelUsageAttributes>("harness.model.cost_micros");
  return modelCostCounter;
}

function getModelCacheReadCounter(): Counter<ModelUsageAttributes> {
  modelCacheReadCounter ??= createCounter<ModelUsageAttributes>("harness.model.cache_read_tokens");
  return modelCacheReadCounter;
}

function getModelCacheWriteCounter(): Counter<ModelUsageAttributes> {
  modelCacheWriteCounter ??= createCounter<ModelUsageAttributes>("harness.model.cache_write_tokens");
  return modelCacheWriteCounter;
}

function getMcpDiscoveryFailedCounter(): Counter<NoMetricAttributes> {
  mcpDiscoveryFailedCounter ??= createCounter<NoMetricAttributes>("harness.mcp.discovery_failed");
  return mcpDiscoveryFailedCounter;
}

function getQuotaRejectionsCounter(): Counter<QuotaRejectionAttributes> {
  quotaRejectionsCounter ??= createCounter<QuotaRejectionAttributes>("harness.quota.rejections");
  return quotaRejectionsCounter;
}

function getMcpInputRequestsCounter(): Counter<McpInputRequestAttributes> {
  mcpInputRequestsCounter ??= createCounter<McpInputRequestAttributes>("harness.mcp.input_requests");
  return mcpInputRequestsCounter;
}

/** Counts one quota rejection using the configured quota's bounded code. */
export function countQuotaRejection(quotaId: CodeType): void {
  safelyRecordMetric(() => {
    getQuotaRejectionsCounter().add(1, { "harness.quota.code": Code.parse(quotaId) });
  });
}

function getWorkerJobsCounter(): Counter<WorkerJobAttributes> {
  workerJobsCounter ??= createCounter<WorkerJobAttributes>("harness.worker.jobs");
  return workerJobsCounter;
}

function getRateLimitDeniedCounter(): Counter<QuotaRejectionAttributes> {
  rateLimitDeniedCounter ??= createCounter<QuotaRejectionAttributes>("harness.rate_limit.denied");
  return rateLimitDeniedCounter;
}

function getRateLimitDegradedCounter(): Counter<QuotaRejectionAttributes> {
  rateLimitDegradedCounter ??= createCounter<QuotaRejectionAttributes>("harness.rate_limit.degraded");
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
  workerQueueLagHistogram ??= createMetricHistogram<NoMetricAttributes>("harness.worker.queue_lag_ms");
  return workerQueueLagHistogram;
}

/** Returns the registry-owned model-latency histogram. */
export function getModelLatencyHistogram(): Histogram<ModelUsageAttributes> {
  modelLatencyHistogram ??= createMetricHistogram<ModelUsageAttributes>("harness.model.latency_ms");
  return modelLatencyHistogram;
}

/** Returns the registry-owned approval-wait histogram. */
export function getApprovalWaitHistogram(): Histogram<ApprovalWaitAttributes> {
  approvalWaitHistogram ??= createMetricHistogram<ApprovalWaitAttributes>("harness.approval.wait_ms");
  return approvalWaitHistogram;
}

/** Returns the registry-owned completed-run counter. */
export function getRunCompletedCounter(): Counter<RunCompletedAttributes> {
  runCompletedCounter ??= createCounter<RunCompletedAttributes>("harness.run.completed");
  return runCompletedCounter;
}

/** Returns the registry-owned tool-call counter. */
export function getToolCallsCounter(): Counter<ToolCallAttributes> {
  toolCallsCounter ??= createCounter<ToolCallAttributes>("harness.tool.calls");
  return toolCallsCounter;
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
