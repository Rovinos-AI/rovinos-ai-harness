// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "./sandbox.js";

describe("SandboxConfigSchema", () => {
  it("defaults unsafe in-process execution to disabled", () => {
    expect(SandboxConfigSchema.parse({})).toEqual({});
  });

  it("accepts the explicit unsafe in-process opt-in", () => {
    expect(SandboxConfigSchema.parse({ allowUnsafeInProcess: true })).toEqual({
      allowUnsafeInProcess: true,
    });
  });

  it("rejects unknown sandbox settings", () => {
    expect(SandboxConfigSchema.safeParse({ allowUnsafe: true }).success).toBe(false);
  });
});
