// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import {
  ASK_USER_TOOL_SPEC,
  AskUserInputSchema,
  AskUserOutputSchema,
  AskUserTool,
} from "./ask-user-tool.js";
import type { RunContext } from "../ports.js";

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
});
