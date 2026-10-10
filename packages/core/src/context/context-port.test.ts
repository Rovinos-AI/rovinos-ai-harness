// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { Event, JsonValue } from "@harness/schemas";
import { NaiveStrategy } from "@harness/context";
import { StrategyContextPort } from "./context-port.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";

function runInput(seq: number, input: string): Event {
  return {
    runId,
    seq,
    ts: 100 + seq,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
    type: "run_input",
    input,
    inputKind: "initial",
  };
}

function createContextPort(calibration: JsonValue, strategy = new NaiveStrategy()) {
  return new StrategyContextPort(strategy, {
    budget: { maxTokens: 100, reserveOutputTokens: 10 },
    model: { provider: "test", model: "test" },
    counter: { count: vi.fn(() => 2) },
    calibration,
  });
}

describe("StrategyContextPort", () => {
  it("builds from supplied events and round-trips strategy calibration", async () => {
    const calibration = { "test/test": 1.5 };
    const strategy = new NaiveStrategy();
    const build = vi.spyOn(strategy, "build");
    const context = createContextPort(calibration, strategy);
    const input = runInput(0, "goal");

    await expect(context.build([input])).resolves.toEqual([
      { role: "user", parts: [{ type: "text", text: "goal" }] },
      { role: "user", parts: [{ type: "text", text: 'Current plan: {"items":[],"notes":""}' }] },
    ]);
    expect(build.mock.calls[0]?.[0]).not.toHaveProperty("calibration");
    const snapshot = await context.snapshot();
    expect(snapshot).toEqual({
      strategyId: "naive",
      strategyVersion: "v3",
      calibration,
    });

    await context.restore(snapshot, [runInput(1, "ignored")]);
    await expect(context.snapshot()).resolves.toEqual(snapshot);
    await expect(context.build([input])).resolves.toEqual([
      { role: "user", parts: [{ type: "text", text: "goal" }] },
      { role: "user", parts: [{ type: "text", text: 'Current plan: {"items":[],"notes":""}' }] },
    ]);
  });

  it("clears calibration when no checkpoint exists", async () => {
    const context = createContextPort({ ratio: 1.25 });

    await context.restore(undefined, []);

    await expect(context.snapshot()).resolves.toMatchObject({ calibration: null });
  });

  it("rejects an invalid checkpoint without exposing its content", async () => {
    const context = createContextPort(null);

    await expect(context.restore({ secret: "synthetic" }, [])).rejects.toMatchObject({
      code: "context_snapshot_invalid",
    });
  });
});
