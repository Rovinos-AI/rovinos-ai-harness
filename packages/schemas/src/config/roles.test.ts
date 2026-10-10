// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RoleConfigSchema, RolesConfigSchema } from "./roles.js";

describe("RoleConfigSchema", () => {
  it("applies role limit defaults", () => {
    expect(RoleConfigSchema.parse({ id: "worker", tools: [] })).toMatchObject({
      id: "worker",
      tools: [],
      maxDepth: 2,
      maxChildren: 8,
    });
  });

  it("accepts valid route, prompt, tool, budget, strategy, and result fields", () => {
    expect(
      RoleConfigSchema.parse({
        id: "worker",
        route: "fast",
        systemPrompt: { file: "prompts/worker.md" },
        tools: ["fs.*"],
        budgets: { maxSteps: 4, maxCostUsd: 1.5, maxWallClockMs: 10_000 },
        contextStrategy: "sliding_window",
        resultSchema: "./result.js#ResultSchema",
        maxDepth: 0,
        maxChildren: 0,
      }),
    ).toMatchObject({
      route: "fast",
      tools: ["fs.*"],
      maxDepth: 0,
      maxChildren: 0,
    });
  });

  it("accepts wildcard access and bounded text prompts", () => {
    expect(RoleConfigSchema.parse({ id: "worker", tools: "*", systemPrompt: "prompt" }).tools).toBe(
      "*",
    );
    expect(
      RoleConfigSchema.safeParse({
        id: "worker",
        tools: [],
        systemPrompt: "x".repeat(8_001),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys, invalid codes, and invalid budgets", () => {
    expect(RoleConfigSchema.safeParse({ id: "Worker", tools: [] }).success).toBe(false);
    expect(RoleConfigSchema.safeParse({ id: "worker", tools: [], extra: true }).success).toBe(
      false,
    );
    expect(
      RoleConfigSchema.safeParse({ id: "worker", tools: [], budgets: { maxSteps: 0 } }).success,
    ).toBe(false);
  });

  it("defaults an absent role set to an empty array", () => {
    expect(RolesConfigSchema.parse(undefined)).toEqual([]);
  });
});
