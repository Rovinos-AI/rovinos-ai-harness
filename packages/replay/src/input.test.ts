// SPDX-License-Identifier: Apache-2.0
import { Code, Event } from "@rovinos/schemas";
import type { PolicyPort } from "@rovinos/core";
import { describe, expect, it } from "vitest";
import { inputReplayOptions, recordInputRun } from "./input-fixture.js";
import { replayRun } from "./replay.js";
import { buildReplayRuntime } from "./replay-runtime.js";
import { ResolvedRunSchema } from "./resolve.js";

describe("recorded human-input runtime", () => {
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
