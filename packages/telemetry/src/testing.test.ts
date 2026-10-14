// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { metrics } from "@opentelemetry/api";
import { countHostAppRejected } from "./metrics.js";
import { createTestMetricCollector } from "./testing.js";

describe("test metric collector", () => {
  it("collects counters in memory after a flush", async () => {
    const collector = createTestMetricCollector();
    try {
      expect(metrics.setGlobalMeterProvider(collector.provider)).toBe(true);
      countHostAppRejected("schema");
      await collector.forceFlush();

      const metricData = collector
        .getMetrics()
        .flatMap(({ scopeMetrics }) =>
          scopeMetrics.flatMap(({ metrics: scopeMetricData }) => scopeMetricData),
        )
        .find(({ descriptor }) => descriptor.name === "harness.host.app_rejected");
      expect(metricData?.dataPoints.map(({ value }) => value)).toEqual([1]);
      expect(metricData?.dataPoints[0]?.attributes).toEqual({
        "harness.host.app_rejected.reason": "schema",
      });
    } finally {
      await collector.provider.shutdown();
    }
  });
});
