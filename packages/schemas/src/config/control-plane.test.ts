// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ControlPlaneConfigSchema } from "./control-plane.js";

describe("ControlPlaneConfigSchema", () => {
  it("defaults reveal to disabled and elicitation to required", () => {
    expect(ControlPlaneConfigSchema.parse({})).toEqual({
      allowReveal: false,
      reveal: { requireElicitation: true },
    });
  });

  it("accepts explicit reveal settings and rejects unknown keys", () => {
    expect(
      ControlPlaneConfigSchema.parse({
        allowReveal: true,
        reveal: { requireElicitation: false },
      }),
    ).toEqual({ allowReveal: true, reveal: { requireElicitation: false } });
    expect(ControlPlaneConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
