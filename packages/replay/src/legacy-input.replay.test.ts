// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { diffRuns } from "./diff.js";
import { inputReplayOptions, recordLegacyInputRun } from "./input-fixture.js";
import { replayRun } from "./replay.js";
import { ResolvedRunSchema } from "./resolve.js";

function humanEvents(events: readonly Event[]): Event[] {
  return events.filter(
    (event) =>
      event.type === "input_requested" ||
      event.type === "input_resolved" ||
      event.type === "run_status_changed" ||
      event.type === "checkpoint_written",
  );
}

describe("legacy live input replay", () => {
  it.each([false, true])(
    "preserves sequential round-zero inputs without suspension (reuseKey=%s)",
    async (reuseKey) => {
      const { resolved, toolRegistry } = await recordLegacyInputRun(reuseKey);
      const execute = vi.spyOn(toolRegistry, "execute");
      const original = resolved.runs[0]?.events ?? [];
      const before = JSON.stringify(resolved);
      const outcome = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
      const requests = outcome.events.filter((event) => event.type === "input_requested");
      const resolutions = outcome.events.filter((event) => event.type === "input_resolved");

      expect(outcome.status).toBe("completed");
      expect(outcome.divergence).toBeUndefined();
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.round)).toEqual([0, 0, 0]);
      expect(requests.map((request) => request.inputKey)).toEqual(
        reuseKey
          ? ["question", "question", "question"]
          : ["question.0", "question.1", "question.2"],
      );
      expect(new Set(requests.map((request) => request.requestId)).size).toBe(3);
      expect(resolutions.map((resolution) => resolution.action)).toEqual([
        "accept",
        "decline",
        "cancel",
      ]);
      expect(resolutions.map((resolution) => resolution.answer)).toEqual([
        { email: "<EMAIL_1>" },
        undefined,
        undefined,
      ]);
      expect(original.some((event) => event.type === "checkpoint_written")).toBe(false);
      expect(outcome.events.some((event) => event.type === "checkpoint_written")).toBe(false);
      expect(
        outcome.events.some(
          (event) => event.type === "run_status_changed" && event.to === "suspended",
        ),
      ).toBe(false);
      expect(diffRuns(humanEvents(original), humanEvents(outcome.events)).identical).toBe(true);
      expect(outcome.events.map((event) => event.type)).toEqual(
        original.map((event) => event.type),
      );
      expect(JSON.stringify(resolved)).toBe(before);
      expect(JSON.stringify(outcome.events)).not.toContain("synthetic.input@example.test");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects an incomplete reused-key legacy recording", async () => {
    const { resolved, toolRegistry } = await recordLegacyInputRun(true);
    const incomplete = ResolvedRunSchema.parse({
      ...resolved,
      runs: resolved.runs.map((run) => ({
        ...run,
        events: run.events.filter(
          (event) => event.type !== "input_resolved" || event.action !== "decline",
        ),
      })),
    });
    const outcome = await replayRun(incomplete, { ...inputReplayOptions, toolRegistry });
    expect(outcome.status).toBe("error");
    expect(outcome.divergence?.code).toBe("replay_missing_result");
  });
});
