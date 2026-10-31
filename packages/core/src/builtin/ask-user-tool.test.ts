// SPDX-License-Identifier: Apache-2.0
import { Code, EventSchema, Id, JsonValue } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_TOOL_SPEC,
  AskUserInputSchema,
  AskUserOutputSchema,
  AskUserTool,
} from "./ask-user-tool.js";
import type { RunContext } from "../ports.js";
import { foldRunState } from "../run-state.js";

const call = {
  callId: Id.parse("11111111111111111111111111"),
  toolId: "agent.ask_user",
  args: { question: "Which option should I choose?" },
};

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: Id.parse("00000000000000000000000000"),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function resumeState(options: { readonly request?: boolean; readonly resolution?: boolean } = {}) {
  const runId = Id.parse("00000000000000000000000001");
  const callId = call.callId;
  const requestId = Id.parse("22222222222222222222222222");
  const envelope = (seq: number) => ({
    runId,
    seq,
    ts: seq,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
  });
  const events = [
    EventSchema.parse({
      ...envelope(0),
      type: "run_created",
      v: 1,
      configHash: "c".repeat(64),
      policyVersion: "test.policy",
    }),
    EventSchema.parse({
      ...envelope(1),
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "started",
    }),
    EventSchema.parse({
      ...envelope(2),
      type: "tool_intent",
      v: 1,
      callId,
      toolId: "agent.ask_user",
      idempotent: false,
      policyDecision: "allow",
      argsHash: "d".repeat(64),
      args: JsonValue.parse(call.args),
    }),
    ...(options.request === true
      ? [
          EventSchema.parse({
            ...envelope(3),
            type: "input_requested",
            v: 1,
            requestId,
            source: "agent",
            callId,
            inputKey: "answer",
            round: 1,
            mode: "form",
            message: "Which option should I choose?",
          }),
        ]
      : []),
    ...(options.resolution === true
      ? [
          EventSchema.parse({
            ...envelope(4),
            type: "input_resolved",
            v: 1,
            requestId,
            source: "agent",
            mode: "form",
            round: 1,
            action: "accept",
            decidedBy: "human",
            approverId: "cli.human",
            waitMs: 1,
            answer: { selected: "yes" },
          }),
        ]
      : []),
  ];
  return foldRunState(events);
}

describe("agent.ask_user tool", () => {
  it("validates optional schemas and bounded expiry", () => {
    expect(AskUserInputSchema.safeParse(call.args).success).toBe(true);
    expect(
      AskUserInputSchema.safeParse({
        question: "Confirm the change?",
        schema: {
          type: "object",
          properties: { confirm: { type: "boolean" } },
          required: ["confirm"],
        },
        expiresInMs: 604_800_000,
      }).success,
    ).toBe(true);
    expect(AskUserInputSchema.safeParse({ question: "x".repeat(2_001) }).success).toBe(false);
    expect(
      AskUserInputSchema.safeParse({ question: "Question?", expiresInMs: 604_800_001 }).success,
    ).toBe(false);
    expect(
      AskUserInputSchema.safeParse({
        question: "Match a value?",
        schema: {
          type: "object",
          properties: { value: { type: "string", pattern: "[a-z]+" } },
        },
      }).success,
    ).toBe(false);
    expect(AskUserInputSchema.safeParse({ ...call.args, extra: true }).success).toBe(false);
  });

  it("requires an answer for acceptance and excludes answers for decline or cancel", () => {
    expect(
      AskUserOutputSchema.safeParse({ action: "accept", answer: { value: "yes" } }).success,
    ).toBe(true);
    expect(AskUserOutputSchema.safeParse({ action: "accept" }).success).toBe(false);
    expect(AskUserOutputSchema.safeParse({ action: "decline" }).success).toBe(true);
    expect(AskUserOutputSchema.safeParse({ action: "cancel" }).success).toBe(true);
    expect(
      AskUserOutputSchema.safeParse({ action: "decline", answer: { value: "no" } }).success,
    ).toBe(false);
  });

  it("advertises a non-idempotent built-in and forwards the validated question", async () => {
    const tool = new AskUserTool();
    const askUser = vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        result: null,
        suspend: true,
        suspendReason: "awaiting_input" as const,
      }),
    );

    expect(tool.getToolSpecs().map(({ toolId }) => toolId)).toEqual(["agent.ask_user"]);
    expect(tool.describe("agent.ask_user")).toMatchObject({ idempotent: false });
    await expect(tool.execute(call, context({ askUser }))).resolves.toMatchObject({
      outcome: "ok",
      suspend: true,
    });
    expect(askUser).toHaveBeenCalledWith({ question: "Which option should I choose?" });
  });

  it("does not expose a model-visible input resolution action", async () => {
    const tool = new AskUserTool();

    expect(tool.getToolSpecs()).toEqual([ASK_USER_TOOL_SPEC]);
    expect(tool.describe("agent.resolve_input")).toBeUndefined();
    await expect(
      tool.execute(
        {
          ...call,
          args: { action: "accept", answer: { value: "model answer" } },
        },
        context({ askUser: vi.fn() }),
      ),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "agent_ask_user_invalid" });
  });

  it("rejects unknown tools, invalid arguments, patterns, and missing ask handlers", async () => {
    const tool = new AskUserTool();
    const askUser = vi.fn();

    await expect(
      tool.execute({ ...call, toolId: "agent.resolve_input" }, context({ askUser })),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "unknown_tool" });
    await expect(
      tool.execute({ ...call, args: { question: "x".repeat(2_001) } }, context({ askUser })),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "agent_ask_user_invalid" });
    await expect(
      tool.execute(
        {
          ...call,
          args: {
            question: "Match a value?",
            schema: {
              type: "object",
              properties: { value: { type: "string", pattern: "[a-z]+" } },
            },
          },
        },
        context({ askUser }),
      ),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "agent_ask_user_invalid" });
    await expect(tool.execute(call, context())).resolves.toMatchObject({
      outcome: "error",
      errorCode: "input_request_invalid",
    });
    expect(askUser).not.toHaveBeenCalled();
  });

  it("rejects a durable retry without an answer response", async () => {
    const tool = new AskUserTool();

    await expect(
      tool.execute(call, context({ inputRetry: { inputResponses: {}, round: 1 } })),
    ).resolves.toMatchObject({
      outcome: "error",
      errorCode: "input_request_invalid",
    });
  });

  it.each([
    { action: "accept", answer: { value: "yes" } },
    { action: "decline" },
    { action: "cancel" },
  ] as const)("returns a resolved $action response from the durable retry", async (response) => {
    const tool = new AskUserTool();
    const resumed = context({
      inputRetry: {
        inputResponses: { answer: response },
        round: 1,
      },
    });

    await expect(tool.execute(call, resumed)).resolves.toMatchObject({
      outcome: "ok",
      result: response,
    });
  });

  it("does not offer a resume strategy for another tool", () => {
    expect(new AskUserTool().resumeStrategy(Code.parse("agent.resolve_input"))).toBeUndefined();
  });

  it("reruns a dangling call when no durable human question exists", async () => {
    const strategy = new AskUserTool().resumeStrategy("agent.ask_user");
    if (strategy === undefined) {
      throw new Error("Expected the ask-user resume strategy.");
    }

    await expect(strategy.onDanglingIntent(call, resumeState())).resolves.toEqual({
      kind: "rerun",
    });
  });

  it("returns a resolved answer from the log without executing the question again", async () => {
    const strategy = new AskUserTool().resumeStrategy("agent.ask_user");
    if (strategy === undefined) {
      throw new Error("Expected the ask-user resume strategy.");
    }

    await expect(
      strategy.onDanglingIntent(call, resumeState({ request: true, resolution: true })),
    ).resolves.toMatchObject({
      kind: "result",
      execution: {
        outcome: "ok",
        result: { action: "accept", answer: { selected: "yes" } },
      },
    });
  });

  it("returns an error for an unresolved durable question instead of asking again", async () => {
    const strategy = new AskUserTool().resumeStrategy("agent.ask_user");
    if (strategy === undefined) {
      throw new Error("Expected the ask-user resume strategy.");
    }

    await expect(
      strategy.onDanglingIntent(call, resumeState({ request: true })),
    ).resolves.toMatchObject({
      kind: "result",
      execution: {
        outcome: "error",
        errorCode: "input_request_invalid",
      },
    });
  });
});
