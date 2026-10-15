// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ControlPlaneConfigSchema } from "./control-plane.js";

describe("ControlPlaneConfigSchema", () => {
  it("defaults reveal to disabled", () => {
    expect(ControlPlaneConfigSchema.parse({})).toEqual({
      allowReveal: false,
    });
  });

  it("accepts the reveal setting and rejects unknown keys", () => {
    expect(
      ControlPlaneConfigSchema.parse({
        allowReveal: true,
      }),
    ).toEqual({ allowReveal: true });
    expect(ControlPlaneConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
