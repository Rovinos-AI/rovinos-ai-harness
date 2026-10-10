// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Event, Message, ModelRef, Part } from "@harness/schemas";
import { SlidingWindowStrategy } from "./sliding-window.js";
import type { ContextStrategyInput, TokenCounter } from "../types.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callId = "22222222222222222222222222";
const model: ModelRef = { provider: "test", model: "test" };
const counter: TokenCounter = { count: (messages) => messages.length };
const strategy = new SlidingWindowStrategy();

const envelope = (seq: number) => ({
  runId,
  seq,
  ts: 100 + seq,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId,
});

function runInput(seq: number): Event {
  return {
    ...envelope(seq),
    type: "run_input",
    input: "goal",
    inputKind: "initial",
  };
}

function modelResponse(seq: number, text: string): Event {
  return modelResponseWithParts(seq, [{ type: "text", text }]);
}

function modelResponseWithParts(seq: number, content: Part[]): Event {
  return {
    ...envelope(seq),
    type: "model_response",
    requestId: "33333333333333333333333333",
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content,
    providerBlobs: null,
  };
}

function toolResult(seq: number, result: Extract<Event, { type: "tool_result" }>["result"]): Event {
  return {
    ...envelope(seq),
    type: "tool_result",
    callId,
    toolId: "lookup",
    outcome: "ok",
    latencyMs: 0,
    result,
  };
}

function compactedSummary(seq: number, fromSeq: number, toSeq: number): Event {
  return {
    ...envelope(seq),
    type: "context_compacted",
    fromSeq,
    toSeq,
    strategy: "summary",
    strategyVersion: "v1",
    summary: "summary",
  };
}

function build(events: readonly Event[], maxTokens: number, reserveOutputTokens = 0) {
  const input: ContextStrategyInput = {
    events,
    budget: { maxTokens, reserveOutputTokens },
    model,
    counter,
  };
  return strategy.build(input);
}

function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("SlidingWindowStrategy", () => {
  it("keeps the full transcript when it fits and does not add a marker", async () => {
    const result = await build(
      [runInput(0), modelResponse(1, "first"), modelResponse(2, "last")],
      3,
    );

    expect(result.messages.map(messageText)).toEqual(["goal", "first", "last"]);
    expect(result.stats).toMatchObject({ estimatedTokens: 3, droppedGroups: 0 });
    expect(result.messages.some((message) => messageText(message).includes("omitted"))).toBe(false);
  });

  it("drops the oldest groups, accounts for the marker, and subtracts the output reserve", async () => {
    const result = await build(
      [
        runInput(0),
        modelResponse(1, "oldest"),
        modelResponse(2, "middle"),
        modelResponse(3, "newest"),
      ],
      4,
      1,
    );

    expect(result.messages.map(messageText)).toEqual([
      "[2 earlier steps omitted]",
      "goal",
      "newest",
    ]);
    expect(result.stats).toMatchObject({ estimatedTokens: 3, droppedGroups: 2 });
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(3);
  });

  it("always retains run input and pinned summary groups", async () => {
    const result = await build(
      [
        runInput(0),
        modelResponse(1, "superseded"),
        compactedSummary(2, 1, 1),
        modelResponse(3, "older"),
        modelResponse(4, "middle"),
        modelResponse(5, "newest"),
      ],
      4,
    );

    expect(result.messages.map(messageText)).toEqual([
      "[2 earlier steps omitted]",
      "goal",
      "Summary of earlier work: summary",
      "newest",
    ]);
    expect(result.pinnedSeqs).toEqual([0, 1]);
    expect(result.stats.compactedRanges).toBe(1);
  });

  it("keeps tool calls and results together as one atomic group", async () => {
    const result = await build(
      [
        runInput(0),
        modelResponseWithParts(1, [
          { type: "text", text: "atomic" },
          { type: "tool_call", callId, toolId: "lookup", args: { query: "x" } },
        ]),
        toolResult(2, { value: "found" }),
        modelResponse(3, "newest"),
      ],
      3,
    );

    expect(result.messages.map(messageText)).toEqual([
      "[1 earlier steps omitted]",
      "goal",
      "newest",
    ]);
    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.stats.droppedGroups).toBe(1);
  });

  it("counts retained offloaded tool results", async () => {
    const result = await build(
      [
        runInput(0),
        modelResponseWithParts(1, [
          { type: "tool_call", callId, toolId: "lookup", args: { query: "x" } },
        ]),
        toolResult(2, { $offloaded: { handle: "wf_test", bytes: 1, preview: "x" } }),
      ],
      3,
    );

    expect(result.stats.offloadedResults).toBe(1);
    expect(result.stats.droppedGroups).toBe(0);
  });

  it("throws when pinned groups alone exceed the available budget", async () => {
    await expect(build([runInput(0), compactedSummary(1, 2, 2)], 1)).rejects.toMatchObject({
      code: "context_pinned_exceeds_budget",
    });
  });

  it("throws rather than exceeding budget when the required marker cannot fit", async () => {
    await expect(build([runInput(0), modelResponse(1, "recent")], 1)).rejects.toMatchObject({
      code: "context_marker_exceeds_budget",
    });
  });

  it("returns the same result for the same input", async () => {
    const events = [runInput(0), modelResponse(1, "old"), modelResponse(2, "new")];

    await expect(build(events, 3)).resolves.toEqual(await build(events, 3));
  });
});
