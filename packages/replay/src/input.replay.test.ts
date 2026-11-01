// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { inputReplayOptions, inputState, recordInputRun } from "./input-fixture.js";
import { diffRuns, normalizeRun } from "./diff.js";
import { replayRun } from "./replay.js";
import { ResolvedRunSchema } from "./resolve.js";

describe("human-input replay gate", () => {
  it("replays multiple batched rounds deterministically without invoking recorded ports", async () => {
    const { resolved, calls, model, toolRegistry } = await recordInputRun({ batch: true });
    const original = JSON.stringify(resolved);
    const portCalls = JSON.stringify([calls, model.requests]);
    const first = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
    const second = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });

    expect(first.status).toBe("completed");
    expect(first.divergence).toBeUndefined();
    expect(second.status).toBe("completed");
    expect(normalizeRun(first.events)).toEqual(normalizeRun(second.events));
    expect(first.events.filter((event) => event.type === "input_requested")).toHaveLength(4);
    expect(first.events.filter((event) => event.type === "input_resolved")).toHaveLength(4);
    expect(
      first.events
        .filter((event) => event.type === "input_requested")
        .map((event) => event.requestState),
    ).toEqual([inputState, inputState, inputState, inputState]);
    expect(JSON.stringify(first.events)).toContain("<EMAIL_1>");
    expect(JSON.stringify(first.events)).not.toContain("synthetic.input@example.test");
    expect(JSON.stringify(resolved)).toBe(original);
    expect(JSON.stringify([calls, model.requests])).toBe(portCalls);
  });

  it("fails the gate when an input resolution is removed", async () => {
    const { resolved, toolRegistry } = await recordInputRun();
    const mutated = ResolvedRunSchema.parse({
      ...resolved,
      runs: resolved.runs.map((run) => ({
        ...run,
        events: run.events.filter((event) => event.type !== "input_resolved"),
      })),
    });
    const outcome = await replayRun(mutated, { ...inputReplayOptions, toolRegistry });
    expect(outcome.status).toBe("error");
    expect(outcome.divergence?.code).toBe("replay_missing_result");
  });

  it("includes content-free input_wait action, source, mode and round differences", async () => {
    const { resolved } = await recordInputRun();
    const events = resolved.runs[0]?.events ?? [];
    const changed = events.map((event) =>
      event.type === "input_resolved"
        ? { ...event, action: "decline" as const, answer: undefined }
        : event,
    );
    const diff = diffRuns(events, changed);
    expect(diff.identical).toBe(false);
    expect(diff.entries.some((entry) => entry.eventKind === "input_wait")).toBe(true);
    expect(JSON.stringify(diff)).not.toContain("email");
    expect(JSON.stringify(diff)).not.toContain("<EMAIL_1>");
    expect(normalizeRun(events).filter((event) => event.kind === "input_wait")).toMatchObject([
      { source: "mcp_mrtr", mode: "form", round: 1, action: "accept" },
      { source: "mcp_mrtr", mode: "form", round: 2, action: "accept" },
    ]);
  });
});
