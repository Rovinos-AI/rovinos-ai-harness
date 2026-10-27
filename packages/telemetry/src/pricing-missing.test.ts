// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import type { Logger } from "@opentelemetry/api-logs";
import { describe, expect, it, vi } from "vitest";
import { emitPricingMissing } from "./pricing-missing.js";

describe("pricing-missing diagnostic", () => {
  it("keeps a logger failure from escaping the model path", () => {
    const emit = vi.fn<Logger["emit"]>(() => {
      throw new Error("synthetic logger failure");
    });
    const logger = { emit } satisfies Pick<Logger, "emit">;

    expect(() =>
      emitPricingMissing(Code.parse("test_provider"), Code.parse("test_model"), logger),
    ).not.toThrow();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      body: "pricing_missing",
      eventName: "harness.model.pricing_missing",
      attributes: {
        "harness.model.provider": "test_provider",
        "harness.model.name": "test_model",
      },
    });
  });
});
