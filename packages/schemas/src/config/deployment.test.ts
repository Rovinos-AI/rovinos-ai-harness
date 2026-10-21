// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DeploymentConfigSchema } from "./deployment.js";

describe("DeploymentConfigSchema", () => {
  it("defaults to a single instance", () => {
    expect(DeploymentConfigSchema.parse({})).toEqual({ mode: "single" });
  });

  it("accepts multi-instance mode and rejects unsupported fields and values", () => {
    expect(DeploymentConfigSchema.parse({ mode: "multi" })).toEqual({ mode: "multi" });
    expect(() => DeploymentConfigSchema.parse({ mode: "cluster" })).toThrow();
    expect(() => DeploymentConfigSchema.parse({ extra: true })).toThrow();
  });
});
