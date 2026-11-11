// SPDX-License-Identifier: Apache-2.0
import { addCostValue, EMPTY_COST_TOTAL } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { projectRunViewUsage } from "./run-view-usage.js";

it.each([
  ["known zero", addCostValue(EMPTY_COST_TOTAL, { version: 1, state: "known", amountMicros: 0 })],
  ["partial", addCostValue(EMPTY_COST_TOTAL, { version: 1, state: "partial", amountMicros: 5 })],
  ["unknown", addCostValue(EMPTY_COST_TOTAL, { version: 1, state: "unknown" })],
])("preserves %s cost completeness in the public run view", (_state, cost) => {
  const usage = { inputTokens: 0, outputTokens: 0, costMicros: 0, cost };

  expect(projectRunViewUsage(usage)).toEqual({ inputTokens: 0, outputTokens: 0, cost });
});
