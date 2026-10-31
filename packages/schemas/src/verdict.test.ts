// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createVerdictSchema, VerdictSchema } from "./verdict.js";

describe("VerdictSchema", () => {
  it("accepts only the content-free verdict shape", () => {
    expect(
      VerdictSchema.safeParse({
        criteria: [{ id: "accuracy", met: true }],
        verdict: "pass",
      }).success,
    ).toBe(true);
    expect(
      VerdictSchema.safeParse({
        criteria: [{ id: "accuracy", met: true }],
        verdict: "pass",
        reasoning: "not part of the verdict",
      }).success,
    ).toBe(false);
  });

  it("requires each supplied criterion exactly once", () => {
    const schema = createVerdictSchema(["accuracy", "style"]);

    expect(
      schema.safeParse({
        criteria: [
          { id: "accuracy", met: true },
          { id: "style", met: false },
        ],
        verdict: "pass",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        criteria: [{ id: "accuracy", met: true }],
        verdict: "pass",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        criteria: [
          { id: "accuracy", met: true },
          { id: "extra", met: false },
        ],
        verdict: "pass",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        criteria: [
          { id: "accuracy", met: true },
          { id: "accuracy", met: false },
        ],
        verdict: "pass",
      }).success,
    ).toBe(false);
  });
});
