// SPDX-License-Identifier: Apache-2.0
import { Code, Event } from "@rovinos/schemas";
import type { PolicyPort } from "@rovinos/core";
import { describe, expect, it, vi } from "vitest";
import { inputReplayOptions, recordInputRun, recordLegacyInputRun } from "./input-fixture.js";
import { replayRun } from "./replay.js";
import { buildReplayRuntime } from "./replay-runtime.js";
import { ResolvedRunSchema } from "./resolve.js";

describe("recorded human-input runtime", () => {
  it.each([false, true])(
    "replays legacy live accept, decline and cancel without real tools (reuseKey=%s)",
    async (reuseKey) => {
      const { resolved, toolRegistry } = await recordLegacyInputRun(reuseKey);
      const execute = vi.spyOn(toolRegistry, "execute");
      const outcome = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
      expect(outcome.status).toBe("completed");
      expect(outcome.divergence).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(
        outcome.events
          .filter((event) => event.type === "input_resolved")
          .map(({ action, answer }) => ({ action, answer })),
      ).toEqual([
        { action: "accept", answer: { email: "<EMAIL_1>" } },
        { action: "decline", answer: undefined },
        { action: "cancel", answer: undefined },
      ]);
      expect(JSON.stringify(outcome.events)).not.toContain("synthetic.input@example.test");
      expect(
        outcome.events.some(
          (event) => event.type === "run_status_changed" && event.to === "suspended",
        ),
      ).toBe(false);
    },
  );

  it.each(["missing", "mode", "authority"] as const)(
    "rejects a legacy recording with a %s resolution",
    async (mutation) => {
      const { resolved, toolRegistry } = await recordLegacyInputRun(true);
      const invalid = ResolvedRunSchema.parse({
        ...resolved,
        runs: resolved.runs.map((run) => ({
          ...run,
          events: run.events.flatMap((event) => {
            if (event.type !== "input_resolved" || event.action !== "decline") {
              return [event];
            }
            if (mutation === "missing") {
              return [];
            }
            return [
              Event.parse({
                ...event,
                ...(mutation === "mode" ? { mode: "url" } : { decidedBy: "policy" }),
              }),
            ];
          }),
        })),
      });
      const outcome = await replayRun(invalid, { ...inputReplayOptions, toolRegistry });
      expect(outcome.status).toBe("error");
      expect(outcome.divergence?.code).toBe(
        mutation === "missing" ? "replay_missing_result" : "replay_divergence",
      );
    },
  );

  it.each([{ email: 42 }, { email: ["<EMAIL_1>"] }, { email: "<EMAIL_1>", unexpected: true }])(
    "rejects a malformed recorded answer through the real resolver",
    async (answer) => {
      const { resolved, toolRegistry } = await recordInputRun({ rounds: 1 });
      const invalid = ResolvedRunSchema.parse({
        ...resolved,
        runs: resolved.runs.map((run) => ({
          ...run,
          events: run.events.map((event) =>
            event.type === "input_resolved" ? Event.parse({ ...event, answer }) : event,
          ),
        })),
      });
      const replay = await buildReplayRuntime(invalid, inputReplayOptions.config, {
        policy: inputReplayOptions.policy,
        toolRegistry,
      });
      try {
        const started = replay.runtime.start("Synthetic input replay");
        const suspended = await started.completion;
        await expect(
          replay.human.resolveInputsAndResume(replay.runtime, started.runId, [
            ...suspended.state.pendingInputs.values(),
          ]),
        ).rejects.toMatchObject({ code: "input_answer_invalid" });
        const events = [];
        for await (const event of replay.runtime.store.read(started.runId)) {
          events.push(event);
        }
        expect(events.some((event) => event.type === "input_resolved")).toBe(false);
      } finally {
        await replay.runtime.close();
      }
    },
  );

  it("fails closed when a recorded token cannot satisfy its original format constraint", async () => {
    const { resolved, toolRegistry } = await recordInputRun({ rounds: 1 });
    const constrained = ResolvedRunSchema.parse({
      ...resolved,
      runs: resolved.runs.map((run) => ({
        ...run,
        events: run.events.map((event) =>
          event.type === "input_requested"
            ? Event.parse({
                ...event,
                schema: {
                  type: "object",
                  properties: { email: { type: "string", format: "email" } },
                  required: ["email"],
                },
              })
            : event,
        ),
      })),
    });
    const replay = await buildReplayRuntime(constrained, inputReplayOptions.config, {
      policy: inputReplayOptions.policy,
      toolRegistry,
    });
    try {
      const started = replay.runtime.start("Synthetic input replay");
      const suspended = await started.completion;
      await expect(
        replay.human.resolveInputsAndResume(replay.runtime, started.runId, [
          ...suspended.state.pendingInputs.values(),
        ]),
      ).rejects.toMatchObject({ code: "input_answer_invalid" });
    } finally {
      await replay.runtime.close();
    }
  });

  it.each(["decline", "cancel"] as const)(
    "replays recorded %s without an answer",
    async (action) => {
      const { resolved, toolRegistry } = await recordInputRun({ rounds: 1, actions: [action] });
      const outcome = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
      expect(outcome.status).toBe("completed");
      expect(outcome.events.find((event) => event.type === "input_resolved")).toMatchObject({
        action,
        decidedBy: "human",
        approverId: "cli.synthetic",
      });
    },
  );

  it("replays agent.ask_user and preserves its recorded token answer", async () => {
    const { resolved, toolRegistry } = await recordInputRun({ agent: true });
    const outcome = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
    expect(
      outcome.events
        .filter((event) => event.type === "model_request")
        .map((event) => event.messages),
    ).toEqual(
      resolved.runs[0]?.events
        .filter((event) => event.type === "model_request")
        .map((event) => event.messages),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.divergence).toBeUndefined();
    expect(outcome.events.find((event) => event.type === "tool_result")).toMatchObject({
      v: 2,
      outcome: "ok",
      result: { action: "accept", answer: { email: "<EMAIL_1>" } },
    });
    expect(outcome.events.find((event) => event.type === "input_resolved")).toMatchObject({
      source: "agent",
      answer: { email: "<EMAIL_1>" },
    });
  });

  it("preserves approval-before-input suspension paths", async () => {
    const policy: PolicyPort = {
      version: Code.parse("synthetic.ask"),
      decide: () => ({
        decision: "ask",
        ruleId: Code.parse("synthetic.ask"),
        reason: Code.parse("approval_required"),
        editable: [],
      }),
    };
    const { resolved, toolRegistry } = await recordInputRun({ policy, rounds: 1 });
    const outcome = await replayRun(resolved, { ...inputReplayOptions, policy, toolRegistry });
    expect(outcome.status).toBe("completed");
    expect(outcome.events.filter((event) => event.type === "approval_resolved")).toHaveLength(1);
    expect(outcome.events.filter((event) => event.type === "input_resolved")).toHaveLength(1);
  });

  it("replays policy-declined input without asking a human", async () => {
    const { resolved, toolRegistry } = await recordInputRun({ policyDecline: true, rounds: 1 });
    const outcome = await replayRun(resolved, { ...inputReplayOptions, toolRegistry });
    expect(outcome.status).toBe("completed");
    expect(outcome.events.find((event) => event.type === "input_resolved")).toMatchObject({
      action: "decline",
      decidedBy: "policy",
    });
  });
});
