// SPDX-License-Identifier: Apache-2.0
import { RunConfigSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { deriveChildBudgets, ChildBudgetExceededError } from "./budgets.js";
import type { RunState } from "../run-state.js";

const parentState = (overrides: Partial<RunState> = {}): RunState => ({
  status: "running",
  nextSeq: 2,
  steps: 0,
  usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
  pendingToolCalls: new Map(),
  pendingApprovals: new Map(),
  approvalRequests: new Map(),
  resolvedApprovals: new Map(),
  segmentId: "00000000000000000000000000",
  startedAt: 100,
  lastTs: 100,
  suspendedTimeMs: 0,
  ...overrides,
});

describe("deriveChildBudgets", () => {
  const parentBudgets = RunConfigSchema.parse({
    budgets: { maxSteps: 10, maxCostUsd: 0.00001, maxWallClockMs: 1_000 },
  }).budgets;

  it.each([
    {
      name: "caps larger role budgets to the parent remainder",
      state: parentState({
        steps: 8,
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 8 },
      }),
      role: { maxSteps: 20, maxCostUsd: 0.00002, maxWallClockMs: 2_000 },
      now: 900,
      expected: { maxSteps: 2, maxCostUsd: 0.000002, maxWallClockMs: 200 },
    },
    {
      name: "keeps smaller role budgets",
      state: parentState({ steps: 1 }),
      role: { maxSteps: 2, maxCostUsd: 0.000003, maxWallClockMs: 100 },
      now: 200,
      expected: { maxSteps: 2, maxCostUsd: 0.000003, maxWallClockMs: 100 },
    },
  ])("$name", ({ state, role, now, expected }) => {
    expect(deriveChildBudgets(state, parentBudgets, role, now)).toMatchObject(expected);
  });

  it("throws budget_exceeded when the parent has no steps left", () => {
    expect(() =>
      deriveChildBudgets(parentState({ steps: 10 }), parentBudgets, undefined, 100),
    ).toThrowError(ChildBudgetExceededError);
  });

  it("throws budget_exceeded when cost or the wall-clock deadline is exhausted", () => {
    expect(() =>
      deriveChildBudgets(
        parentState({ usage: { inputTokens: 0, outputTokens: 0, costMicros: 10 } }),
        parentBudgets,
        undefined,
        100,
      ),
    ).toThrowError(ChildBudgetExceededError);
    expect(() => deriveChildBudgets(parentState(), parentBudgets, undefined, 1_100)).toThrowError(
      ChildBudgetExceededError,
    );
  });

  it("uses a role cost limit when the parent has no cost limit", () => {
    const budgets = RunConfigSchema.parse({ budgets: { maxCostUsd: undefined } }).budgets;
    expect(deriveChildBudgets(parentState(), budgets, { maxCostUsd: 0.5 }, 100).maxCostUsd).toBe(
      0.5,
    );
  });

  it("excludes parent suspension time when calculating the deadline", () => {
    const state = parentState({ suspendedTimeMs: 200 });
    expect(deriveChildBudgets(state, parentBudgets, undefined, 900).maxWallClockMs).toBe(400);
  });
});
