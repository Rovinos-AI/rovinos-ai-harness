// SPDX-License-Identifier: Apache-2.0
import { metrics } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEMETRY_DROP_REASONS,
  TELEMETRY_METRIC_STRING_ATTRIBUTES,
  HOST_APP_REJECTED_REASONS,
  countHostAppRejected,
  countDroppedTelemetry,
  countSentinelScopeReduced,
  countSkippedShortValues,
  type TelemetryDropReason,
} from "./metrics.js";

const meter = metrics.getMeter("@harness/telemetry");
const counter = meter.createCounter("harness.telemetry.dropped");
const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue(meter);
const createCounter = vi.spyOn(meter, "createCounter").mockReturnValue(counter);
const add = vi.spyOn(counter, "add");

const dropReasons: readonly TelemetryDropReason[] = TELEMETRY_DROP_REASONS;

describe("countDroppedTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    add.mockImplementation(() => undefined);
  });

  it("records the bounded reason as the counter's only attribute", () => {
    for (const reason of dropReasons) {
      countDroppedTelemetry(reason);
    }

    expect(getMeter).toHaveBeenCalledWith("@harness/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.telemetry.dropped");
    expect(add.mock.calls).toEqual(dropReasons.map((reason) => [1, { reason }]));
  });

  it("contains metric provider failures", () => {
    add.mockImplementation(() => {
      throw new Error("metric provider failure");
    });

    expect(() => {
      countDroppedTelemetry("processor_error");
    }).not.toThrow();
  });

  it("counts host app rejections with a bounded reason", () => {
    countHostAppRejected("unknown_tool");

    expect(createCounter).toHaveBeenCalledWith("harness.host.app_rejected");
    expect(add).toHaveBeenCalledWith(1, { reason: "unknown_tool" });
    expect(HOST_APP_REJECTED_REASONS).toEqual(["unknown_tool"]);
  });

  it("counts skipped short sentinel values without attributes", () => {
    countSkippedShortValues(3);

    expect(getMeter).toHaveBeenCalledWith("@harness/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.short_values_skipped");
    expect(add).toHaveBeenCalledWith(3);
  });

  it("uses only closed-enum string attributes for metric instruments", () => {
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES).toEqual({
      "harness.telemetry.dropped.reason": dropReasons,
      "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
    });
    expect(
      TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.telemetry.dropped.reason"].length,
    ).toBeGreaterThan(0);
  });

  it("counts reduced global scan scope without metric attributes", () => {
    countSentinelScopeReduced();

    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.scope_reduced");
    expect(add).toHaveBeenCalledWith(1);
  });
});
