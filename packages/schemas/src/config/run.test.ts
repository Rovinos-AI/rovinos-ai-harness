// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RunConfigSchema } from "./run.js";

describe("RunConfigSchema resume policy", () => {
  it("defaults non-idempotent dangling intents to escalation", () => {
    expect(RunConfigSchema.parse({}).resume.onNonIdempotent).toBe("escalate");
  });

  it("accepts the fail override and rejects unknown policies", () => {
    expect(
      RunConfigSchema.parse({ resume: { onNonIdempotent: "fail" } }).resume.onNonIdempotent,
    ).toBe("fail");
    expect(() => RunConfigSchema.parse({ resume: { onNonIdempotent: "retry" } })).toThrow();
  });
});
