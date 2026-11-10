// SPDX-License-Identifier: Apache-2.0
import { metrics } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEMETRY_DROP_REASONS,
  TELEMETRY_METRIC_STRING_ATTRIBUTES,
  HOST_APP_REJECTED_REASONS,
  APPROVAL_DECISIONS,
  RUN_COMPLETION_OUTCOMES,
  TOOL_CALL_OUTCOMES,
  POLICY_DECISIONS,
  MCP_INPUT_REQUEST_OUTCOMES,
  WORKER_JOB_OUTCOMES,
  RATE_LIMIT_BACKENDS,
  RATE_LIMIT_KEY_KINDS,
  METRIC_ALLOWLIST,
  countHostAppRejected,
  countHostAppSpansAccepted,
  countCompletedRun,
  countModelUsage,
  countMcpDiscoveryFailed,
  countMcpInputRequest,
  countPiiBlobHit,
  countPiiDetectorDegraded,
  countPolicyDecision,
  countQuotaRejection,
  countToolCall,
  countDroppedTelemetry,
  countWorkerJob,
  countRateLimitDenied,
  countRateLimitDegraded,
  recordWorkerQueueLag,
  recordApprovalWait,
  recordModelLatency,
  countSentinelScopeReduced,
  countSkippedShortValues,
  selectTelemetryMeterProvider,
  type TelemetryDropReason,
} from "./metrics.js";

const meter = metrics.getMeter("@rovinos/telemetry");
const counter = meter.createCounter("harness.telemetry.dropped");
const histogram = meter.createHistogram("harness.worker.queue_lag_ms");
const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue(meter);
const createdMetricNames: string[] = [];
function createAllowlistedCounter(name: string): typeof counter {
  if (!Object.hasOwn(METRIC_ALLOWLIST, name)) {
    throw new Error("metric_not_allowlisted");
  }
  createdMetricNames.push(name);
  return counter;
}
const createCounter = vi.spyOn(meter, "createCounter").mockImplementation(createAllowlistedCounter);
function createAllowlistedHistogram(name: string): typeof histogram {
  if (!Object.hasOwn(METRIC_ALLOWLIST, name)) {
    throw new Error("metric_not_allowlisted");
  }
  createdMetricNames.push(name);
  return histogram;
}
const createHistogram = vi
  .spyOn(meter, "createHistogram")
  .mockImplementation(createAllowlistedHistogram);
const add = vi.spyOn(counter, "add");
const record = vi.spyOn(histogram, "record");

const dropReasons: readonly TelemetryDropReason[] = TELEMETRY_DROP_REASONS;

function expectAddCallsAreAllowlisted(name: keyof typeof METRIC_ALLOWLIST): void {
  const allowedKeys = METRIC_ALLOWLIST[name];
  for (const [, attributes] of add.mock.calls) {
    expect(
      Object.keys(attributes ?? {}).every((key) =>
        allowedKeys.some((allowedKey) => allowedKey === key),
      ),
    ).toBe(true);
  }
}

describe("countDroppedTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    add.mockImplementation(() => undefined);
    record.mockImplementation(() => undefined);
  });

  describe("rate-limit metrics", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      add.mockImplementation(() => undefined);
    });

    it("uses only bounded key-kind and backend attributes", () => {
      for (const keyKind of RATE_LIMIT_KEY_KINDS) {
        countRateLimitDenied(keyKind);
      }
      for (const backend of RATE_LIMIT_BACKENDS) {
        countRateLimitDegraded(backend);
      }

      expect(createCounter).toHaveBeenCalledWith("harness.rate_limit.denied");
      expect(createCounter).toHaveBeenCalledWith("harness.rate_limit.degraded");
      expect(add.mock.calls).toEqual([
        [1, { "harness.rate_limit.denied.key_kind": "provider" }],
        [1, { "harness.rate_limit.denied.key_kind": "control_plane" }],
        [1, { "harness.rate_limit.degraded.backend": "postgres" }],
        [1, { "harness.rate_limit.degraded.backend": "redis" }],
      ]);
      expect(METRIC_ALLOWLIST["harness.rate_limit.denied"]).toEqual([
        "harness.rate_limit.denied.key_kind",
      ]);
      expect(METRIC_ALLOWLIST["harness.rate_limit.degraded"]).toEqual([
        "harness.rate_limit.degraded.backend",
      ]);
    });
  });

  it("records the bounded reason as the counter's only attribute", () => {
    for (const reason of dropReasons) {
      countDroppedTelemetry(reason);
    }

    expect(getMeter).toHaveBeenCalledWith("@rovinos/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.telemetry.dropped");
    expect(add.mock.calls).toEqual(
      dropReasons.map((reason) => [1, { "harness.telemetry.dropped.reason": reason }]),
    );
    expectAddCallsAreAllowlisted("harness.telemetry.dropped");
  });

  it("contains metric provider failures", () => {
    add.mockImplementation(() => {
      throw new Error("metric provider failure");
    });

    expect(() => {
      countDroppedTelemetry("processor_error");
    }).not.toThrow();
    expectAddCallsAreAllowlisted("harness.telemetry.dropped");
  });

  it("counts host app rejections with a bounded reason", () => {
    for (const reason of HOST_APP_REJECTED_REASONS) {
      countHostAppRejected(reason);
    }

    expect(createCounter).toHaveBeenCalledWith("harness.host.app_rejected");
    expect(add.mock.calls).toEqual(
      HOST_APP_REJECTED_REASONS.map((reason) => [
        1,
        { "harness.host.app_rejected.reason": reason },
      ]),
    );
    expectAddCallsAreAllowlisted("harness.host.app_rejected");
  });

  it("counts policy decisions with only the closed decision attribute", () => {
    for (const decision of POLICY_DECISIONS) {
      countPolicyDecision(decision);
    }

    expect(createCounter).toHaveBeenCalledWith("harness.policy.decisions");
    expect(add.mock.calls).toEqual(
      POLICY_DECISIONS.map((decision) => [1, { "harness.policy.decision": decision }]),
    );
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.policy.decision"]).toEqual(POLICY_DECISIONS);
    expectAddCallsAreAllowlisted("harness.policy.decisions");
  });

  it("counts quota rejections using only the configured quota code", () => {
    countQuotaRejection("team");

    expect(createCounter).toHaveBeenCalledWith("harness.quota.rejections");
    expect(add).toHaveBeenCalledWith(1, { "harness.quota.id": "team" });
    expectAddCallsAreAllowlisted("harness.quota.rejections");
  });

  it("counts opaque PII blob hits without attributes", () => {
    countPiiBlobHit();

    expect(createCounter).toHaveBeenCalledWith("harness.pii.blob_hit");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.pii.blob_hit");
  });

  it("counts degraded PII detection without attributes", () => {
    countPiiDetectorDegraded();

    expect(createCounter).toHaveBeenCalledWith("harness.pii.detector_degraded");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.pii.detector_degraded");
  });

  it("counts accepted app spans without attributes", () => {
    countHostAppSpansAccepted(3);

    expect(createCounter).toHaveBeenCalledWith("harness.host.app_spans_accepted");
    expect(add).toHaveBeenCalledWith(3);
    expectAddCallsAreAllowlisted("harness.host.app_spans_accepted");
  });

  it("counts model tokens and cost using only namespaced provider and model attributes", () => {
    countModelUsage(
      {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        costMicros: 11,
      },
      "sample",
      "model-a",
    );
    expect(createCounter).toHaveBeenCalledWith("harness.model.tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cache_read_tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cache_write_tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cost_micros");
    expect(add.mock.calls).toEqual([
      [5, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [1, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [2, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [11, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
    ]);
    expectAddCallsAreAllowlisted("harness.model.tokens");
    expectAddCallsAreAllowlisted("harness.model.cache_read_tokens");
    expectAddCallsAreAllowlisted("harness.model.cache_write_tokens");
    expectAddCallsAreAllowlisted("harness.model.cost_micros");
  });

  it("counts skipped short sentinel values without attributes", () => {
    countSkippedShortValues(3);

    expect(getMeter).toHaveBeenCalledWith("@rovinos/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.short_values_skipped");
    expect(add).toHaveBeenCalledWith(3);
    expectAddCallsAreAllowlisted("harness.sentinel.short_values_skipped");
  });

  it("counts MCP discovery failures without server-id attributes", () => {
    countMcpDiscoveryFailed();

    expect(createCounter).toHaveBeenCalledWith("harness.mcp.discovery_failed");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.mcp.discovery_failed");
  });

  it("counts MCP input outcomes without server identifiers", () => {
    for (const outcome of MCP_INPUT_REQUEST_OUTCOMES) {
      countMcpInputRequest(outcome);
    }

    expect(createCounter).toHaveBeenCalledWith("harness.mcp.input_requests");
    expect(add.mock.calls).toEqual(
      MCP_INPUT_REQUEST_OUTCOMES.map((outcome) => [
        1,
        { "harness.mcp.input_requests.outcome": outcome },
      ]),
    );
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.mcp.input_requests.outcome"]).toEqual(
      MCP_INPUT_REQUEST_OUTCOMES,
    );
    expectAddCallsAreAllowlisted("harness.mcp.input_requests");
  });

  it("uses only closed-enum string attributes for metric instruments", () => {
    expect(HOST_APP_REJECTED_REASONS).toEqual([
      "schema",
      "size",
      "rate",
      "unknown_app",
      "unknown_tool",
      "unknown_span",
      "session_cap",
      "request_disabled",
      "request_invalid",
      "request_unavailable",
      "user_denied",
    ]);
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES).toEqual({
      "harness.telemetry.dropped.reason": dropReasons,
      "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
      "harness.policy.decision": POLICY_DECISIONS,
      "harness.mcp.input_requests.outcome": MCP_INPUT_REQUEST_OUTCOMES,
      "harness.worker.jobs.outcome": WORKER_JOB_OUTCOMES,
      "harness.rate_limit.denied.key_kind": RATE_LIMIT_KEY_KINDS,
      "harness.rate_limit.degraded.backend": RATE_LIMIT_BACKENDS,
      "harness.run.completed.outcome": RUN_COMPLETION_OUTCOMES,
      "harness.approval.wait_ms.decision": APPROVAL_DECISIONS,
      "harness.tool.calls.outcome": TOOL_CALL_OUTCOMES,
    });
    expect(
      TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.telemetry.dropped.reason"].length,
    ).toBeGreaterThan(0);
  });

  it("counts reduced global scan scope without metric attributes", () => {
    countSentinelScopeReduced();

    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.scope_reduced");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.sentinel.scope_reduced");
  });

  it("records worker outcomes and queue lag without identifiers", () => {
    for (const outcome of WORKER_JOB_OUTCOMES) {
      countWorkerJob(outcome);
    }
    recordWorkerQueueLag(25);
    recordWorkerQueueLag(Number.NaN);

    expect(createCounter).toHaveBeenCalledWith("harness.worker.jobs");
    expect(add.mock.calls).toEqual(
      WORKER_JOB_OUTCOMES.map((outcome) => [1, { "harness.worker.jobs.outcome": outcome }]),
    );
    expectAddCallsAreAllowlisted("harness.worker.jobs");
    expect(createHistogram).toHaveBeenCalledWith("harness.worker.queue_lag_ms");
    expect(record).toHaveBeenCalledExactlyOnceWith(25);
    expect(METRIC_ALLOWLIST["harness.worker.queue_lag_ms"]).toEqual([]);
  });

  it("records run, approval, model, and tool metrics with bounded attributes", () => {
    for (const outcome of RUN_COMPLETION_OUTCOMES) {
      countCompletedRun(outcome);
    }
    for (const decision of APPROVAL_DECISIONS) {
      recordApprovalWait(25, decision);
    }
    recordModelLatency(50, "sample", "model-a");
    for (const outcome of TOOL_CALL_OUTCOMES) {
      countToolCall(outcome);
    }
    recordModelLatency(Number.NaN, "sample", "model-a");
    recordApprovalWait(-1, "approve");

    expect(createCounter).toHaveBeenCalledWith("harness.run.completed");
    expect(add.mock.calls.slice(0, RUN_COMPLETION_OUTCOMES.length)).toEqual(
      RUN_COMPLETION_OUTCOMES.map((outcome) => [
        1,
        { "harness.run.completed.outcome": outcome },
      ]),
    );
    expect(createHistogram).toHaveBeenCalledWith("harness.approval.wait_ms");
    expect(createHistogram).toHaveBeenCalledWith("harness.model.latency_ms");
    expect(record.mock.calls).toEqual([
      ...APPROVAL_DECISIONS.map((decision) => [
        25,
        { "harness.approval.wait_ms.decision": decision },
      ]),
      [
        50,
        { "harness.model.provider": "sample", "harness.model.name": "model-a" },
      ],
    ]);
    expect(createCounter).toHaveBeenCalledWith("harness.tool.calls");
    expect(add.mock.calls.slice(RUN_COMPLETION_OUTCOMES.length)).toEqual(
      TOOL_CALL_OUTCOMES.map((outcome) => [1, { "harness.tool.calls.outcome": outcome }]),
    );
    expect(METRIC_ALLOWLIST["harness.approval.wait_ms"]).toEqual([
      "harness.approval.wait_ms.decision",
    ]);
    expect(METRIC_ALLOWLIST["harness.model.latency_ms"]).toEqual([
      "harness.model.provider",
      "harness.model.name",
    ]);
  });

  it("has an instrument for every allowlist entry and no stale entries", () => {
    expect([...createdMetricNames].sort()).toEqual(Object.keys(METRIC_ALLOWLIST).sort());
  });

  it("enumerates every metric instrument through an allowlisted creation path", () => {
    createdMetricNames.length = 0;
    selectTelemetryMeterProvider(new MeterProvider());
    selectTelemetryMeterProvider(undefined);

    for (const reason of TELEMETRY_DROP_REASONS) {
      countDroppedTelemetry(reason);
    }
    for (const reason of HOST_APP_REJECTED_REASONS) {
      countHostAppRejected(reason);
    }
    for (const decision of POLICY_DECISIONS) {
      countPolicyDecision(decision);
    }
    countQuotaRejection("quota");
    countPiiBlobHit();
    countPiiDetectorDegraded();
    countHostAppSpansAccepted(1);
    countSkippedShortValues(1);
    countSentinelScopeReduced();
    countModelUsage(
      { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costMicros: 1 },
      "sample",
      "model",
    );
    countMcpDiscoveryFailed();
    for (const outcome of MCP_INPUT_REQUEST_OUTCOMES) {
      countMcpInputRequest(outcome);
    }
    for (const outcome of WORKER_JOB_OUTCOMES) {
      countWorkerJob(outcome);
    }
    for (const outcome of RUN_COMPLETION_OUTCOMES) {
      countCompletedRun(outcome);
    }
    for (const decision of APPROVAL_DECISIONS) {
      recordApprovalWait(1, decision);
    }
    recordModelLatency(1, "sample", "model");
    for (const outcome of TOOL_CALL_OUTCOMES) {
      countToolCall(outcome);
    }
    for (const keyKind of RATE_LIMIT_KEY_KINDS) {
      countRateLimitDenied(keyKind);
    }
    for (const backend of RATE_LIMIT_BACKENDS) {
      countRateLimitDegraded(backend);
    }
    recordWorkerQueueLag(1);

    expect([...new Set(createdMetricNames)].sort()).toEqual(Object.keys(METRIC_ALLOWLIST).sort());
  });
});
