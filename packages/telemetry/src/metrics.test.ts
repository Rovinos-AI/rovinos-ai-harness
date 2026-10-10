// SPDX-License-Identifier: Apache-2.0
import { metrics } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryDropReason } from "./metrics.js";
import { countDroppedTelemetry } from "./metrics.js";

const meter = metrics.getMeter("@harness/telemetry");
const counter = meter.createCounter("harness.telemetry.dropped");
const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue(meter);
const createCounter = vi.spyOn(meter, "createCounter").mockReturnValue(counter);
const add = vi.spyOn(counter, "add");

const dropReasons: readonly TelemetryDropReason[] = [
  "unregistered_span",
  "unregistered_log_record",
  "unregistered_attr",
  "invalid_attr",
  "event_stripped",
  "leak_sentinel",
  "processor_error",
];

describe("countDroppedTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
