// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HarnessError } from "@harness/schemas";
import {
  ModelOutputInvalidError,
  ProviderError,
  ProviderErrorCodeSchema,
  ProviderNotRegisteredError,
} from "./errors.js";

describe("provider errors", () => {
  it.each([
    ["provider_rate_limited", true],
    ["provider_timeout", true],
    ["provider_unavailable", true],
    ["provider_bad_request", false],
    ["provider_auth", false],
    ["provider_content_filtered", false],
    ["provider_unknown", false],
  ] as const)("assigns retryability for %s", (code, retryable) => {
    const error = new ProviderError(code);

    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(ProviderErrorCodeSchema.parse(code)).toBe(code);
  });

  it("retains optional retry delay and HTTP status", () => {
    const error = new ProviderError("provider_rate_limited", {
      retryAfterMs: 250,
      status: 429,
    });

    expect(error).toMatchObject({ retryAfterMs: 250, status: 429 });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid retry delays: %s",
    (retryAfterMs) => {
      expect(() => new ProviderError("provider_rate_limited", { retryAfterMs })).toThrow(
        RangeError,
      );
    },
  );

  it("uses a stable code for missing provider registrations", () => {
    const error = new ProviderNotRegisteredError("unknown");

    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe("provider_not_registered");
  });

  it("retains only bounded repair count and issue paths on invalid model output", () => {
    const error = new ModelOutputInvalidError(2, [
      { path: ["answer"], code: "invalid_type", expected: "number" },
    ]);

    expect(error).toMatchObject({
      code: "model_output_invalid",
      repairAttempts: 2,
      issuePaths: [["answer"]],
    });
    expect(JSON.stringify(error)).not.toContain("expected");
  });
});
