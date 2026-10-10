// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attr } from "../attr.js";
import { sanitizeAttributes } from "./sanitize-attributes.js";

const metricMocks = vi.hoisted(() => ({
  record: vi.fn<(reason: string) => void>(),
}));

vi.mock("../metrics.js", () => ({
  countDroppedTelemetry: metricMocks.record,
}));

describe("sanitizeAttributes", () => {
  beforeEach(() => {
    metricMocks.record.mockClear();
  });

  it("copies valid safe attributes and drops unknown or invalid values", () => {
    const definition = {
      shape: {
        "harness.test.code": attr.code(),
        "harness.test.count": attr.nonnegativeInt(),
      },
    };
    const source = {
      "harness.test.code": "safe_code",
      "harness.test.count": -1,
      "harness.unregistered": true,
    };

    const sanitized = sanitizeAttributes(definition, source);

    expect(sanitized).toEqual({ "harness.test.code": "safe_code" });
    expect(sanitized).not.toBe(source);
    expect(metricMocks.record.mock.calls).toEqual([["invalid_attr"], ["unregistered_attr"]]);
  });

  it.each([
    { definition: { shape: null }, attrs: {}, name: "malformed shape" },
    { definition: { shape: {} }, attrs: null, name: "malformed attributes" },
  ])("rejects $name", ({ definition, attrs }) => {
    expect(() => sanitizeAttributes(definition, attrs)).toThrowError(
      "Telemetry attributes are malformed.",
    );
  });

  it("contains unexpected schema failures at the caller boundary", () => {
    const definition = {
      shape: {
        "harness.test.code": {
          safeParse() {
            throw new Error("untrusted schema failure");
          },
        },
      },
    };

    expect(() => sanitizeAttributes(definition, { "harness.test.code": "value" })).toThrowError(
      "untrusted schema failure",
    );
  });

  it("rejects malformed parser results", () => {
    const definition = {
      shape: {
        "harness.test.code": {
          safeParse: () => "invalid result",
        },
      },
    };

    expect(sanitizeAttributes(definition, { "harness.test.code": "value" })).toEqual({});
    expect(metricMocks.record).toHaveBeenCalledWith("invalid_attr");
  });
});
