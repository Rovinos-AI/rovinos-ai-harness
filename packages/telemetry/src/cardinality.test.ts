// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { METRIC_ALLOWLIST, METRIC_ATTRIBUTE_BOUNDS } from "./metrics.js";
import { CardinalityGuard, metricAttributeBoundViolations } from "./cardinality.js";

describe("metric cardinality bounds", () => {
  it("accepts the production metric registry", () => {
    expect(metricAttributeBoundViolations(METRIC_ALLOWLIST, METRIC_ATTRIBUTE_BOUNDS)).toEqual([]);
  });

  it("rejects prohibited, unbounded and oversized attributes", () => {
    const allowlist = {
      "harness.test.metric": ["harness.user.id", "harness.status", "harness.outcome"],
    };
    const bounds = {
      "harness.test.metric": {
        "harness.user.id": { kind: "config", source: "config.users" },
        "harness.status": {
          kind: "enum",
          values: Array.from({ length: 51 }, (_, index) => String(index)),
        },
      },
    } as const;

    expect(metricAttributeBoundViolations(allowlist, bounds)).toEqual([
      "harness.test.metric.harness.user.id:unbounded_attribute_name",
      "harness.test.metric.harness.status:enum_too_large",
      "harness.test.metric.harness.outcome:missing_attribute_bound",
    ]);
  });
});

describe("CardinalityGuard", () => {
  it("admits up to the per-metric limit and counts each rejected combination", () => {
    const onDrop = vi.fn();
    const logger = { warn: vi.fn() };
    const guard = new CardinalityGuard({ maxSeries: 2, onDrop, logger });
    const metric = Code.parse("harness.model.tokens");

    expect(guard.admit(metric, { provider: "first" })).toBe(true);
    expect(guard.admit(metric, { provider: "second" })).toBe(true);
    expect(guard.admit(metric, { provider: "third" })).toBe(false);
    expect(guard.admit(metric, { provider: "fourth" })).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("metric_cardinality_exceeded", {
      "metric.name": metric,
    });
  });

  it("isolates series limits between metrics and canonicalizes attribute order", () => {
    const guard = new CardinalityGuard({ maxSeries: 1, onDrop: vi.fn(), logger: { warn: vi.fn() } });
    const metric = Code.parse("harness.model.tokens");

    expect(guard.admit(metric, { provider: "first", model: "sample" })).toBe(true);
    expect(guard.admit(metric, { model: "sample", provider: "first" })).toBe(true);
    expect(guard.admit(metric, { provider: "second", model: "sample" })).toBe(false);
    expect(guard.admit(Code.parse("harness.tool.calls"), { outcome: "ok" })).toBe(true);
  });

  it("defaults to 100 distinct series per metric", () => {
    const guard = new CardinalityGuard({ onDrop: vi.fn(), logger: { warn: vi.fn() } });
    const metric = Code.parse("harness.model.tokens");

    for (let index = 0; index < 100; index += 1) {
      expect(guard.admit(metric, { series: String(index) })).toBe(true);
    }
    expect(guard.admit(metric, { series: "overflow" })).toBe(false);
  });

  it("always admits the bounded telemetry-drop counter to avoid recursive drops", () => {
    const onDrop = vi.fn();
    const guard = new CardinalityGuard({ maxSeries: 1, onDrop, logger: { warn: vi.fn() } });

    expect(
      guard.admit(Code.parse("harness.telemetry.dropped"), {
        "harness.telemetry.dropped.reason": "cardinality",
      }),
    ).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
