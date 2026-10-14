// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Id, type Event, type Message, type ModelRef, type Part } from "@harness/schemas";
import { SlidingWindowStrategy } from "./sliding-window.js";
import type { ContextStrategyInput, TokenCounter } from "../types.js";
import { HeuristicTokenCounter } from "../token-counter.js";
import type { Plan } from "../plan.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callId = "22222222222222222222222222";
const planCallId = Id.parse("44444444444444444444444444");
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

function planUpdate(seq: number, plan: Plan): Event[] {
  return [
    {
      ...envelope(seq),
      type: "tool_intent",
      callId: planCallId,
      toolId: "update_plan",
      idempotent: true,
      policyDecision: "allow",
      argsHash: "c".repeat(64),
      args: { plan },
    },
    {
      ...envelope(seq + 1),
      type: "tool_result",
      callId: planCallId,
      toolId: "update_plan",
      outcome: "ok",
      latencyMs: 0,
      result: plan,
    },
  ];
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
      4,
    );

    expect(result.messages.map(messageText)).toEqual(["goal", "first", "last"]);
    expect(result.stats).toMatchObject({ estimatedTokens: 3, droppedGroups: 0 });
    expect(result.stablePrefixMessages).toBe(2);
    expect(result.messages.some((message) => messageText(message).includes("omitted"))).toBe(false);

    const heuristicResult = await strategy.build({
      events: [runInput(0), modelResponse(1, "a"), modelResponse(2, "b")],
      budget: { maxTokens: 64, reserveOutputTokens: 0 },
      model,
      counter: new HeuristicTokenCounter(),
    });

    expect(heuristicResult.messages.map(messageText)).toEqual(["goal", "a", "b"]);
    expect(heuristicResult.stats.droppedGroups).toBe(0);
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
      "goal",
      "[2 earlier steps omitted]",
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
      "goal",
      "Summary of earlier work: summary",
      "[2 earlier steps omitted]",
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
      "goal",
      "[1 earlier steps omitted]",
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
      4,
    );

    expect(result.stats.offloadedResults).toBe(1);
    expect(result.stats.droppedGroups).toBe(0);
    expect(result.messages.at(-1)).toMatchObject({ role: "tool" });
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

    await expect(build(events, 4)).resolves.toEqual(await build(events, 4));
  });

  it("keeps the deterministic plan message last and counts it as pinned", async () => {
    const currentPlan: Plan = {
      items: [{ id: "task.one", text: "do it", status: "doing" }],
      notes: "keep",
    };
    const result = await build(
      [
        runInput(0),
        modelResponse(1, "oldest"),
        modelResponse(2, "middle"),
        modelResponse(3, "newest"),
        ...planUpdate(4, currentPlan),
      ],
      4,
    );

    expect(result.messages.map(messageText)).toEqual([
      "goal",
      "[2 earlier steps omitted]",
      "newest",
      `Current plan: ${JSON.stringify(currentPlan)}`,
    ]);
    expect(result.messages.at(-1)?.role).toBe("user");
    expect(result.stats).toMatchObject({ estimatedTokens: 4, droppedGroups: 2 });
  });

  it("rejects when a large pinned plan and omission marker exceed the budget", async () => {
    const largePlan: Plan = { items: [], notes: "x".repeat(1000) };
    const weightedCounter: TokenCounter = {
      count: (messages) =>
        messages.reduce(
          (total, message) =>
            total +
            Math.max(
              1,
              Math.ceil(
                message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("").length / 100,
              ),
            ),
          0,
        ),
    };

    await expect(
      strategy.build({
        events: [
          runInput(0),
          modelResponse(1, "old"),
          modelResponse(2, "new"),
          ...planUpdate(3, largePlan),
        ],
        budget: { maxTokens: 12, reserveOutputTokens: 0 },
        model,
        counter: weightedCounter,
      }),
    ).rejects.toMatchObject({ code: "context_pinned_exceeds_budget" });
  });

  it("keeps its strategy identity and version stable", () => {
    expect(strategy.id).toBe("sliding_window");
    expect(strategy.version).toBe("v4");
  });

  it.each([
    [false, 4, "v4"],
    [false, 2, "v4"],
    [true, 4, "v5_cache_aware_4"],
    [true, 2, "v5_cache_aware_2"],
  ] as const)(
    "encodes cache mode and chunk size in the strategy version",
    (cacheAware, size, version) => {
      expect(new SlidingWindowStrategy({ cacheAware, dropChunkGroups: size }).version).toBe(
        version,
      );
    },
  );

  it("keeps the retained prefix stable across cache-aware chunk drops", async () => {
    const cacheAware = new SlidingWindowStrategy({ cacheAware: true });
    const events = [
      runInput(0),
      ...Array.from({ length: 11 }, (_, index) =>
        modelResponse(index + 1, `step-${String(index)}`),
      ),
    ];
    const input: ContextStrategyInput = {
      events,
      budget: { maxTokens: 8, reserveOutputTokens: 0 },
      model,
      counter,
    };
    const first = await cacheAware.build(input);
    const second = await cacheAware.build({
      ...input,
      events: [...events, modelResponse(12, "step-11")],
    });

    expect(first.stats.droppedGroups).toBe(8);
    expect(second.stats.droppedGroups).toBe(8);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.stablePrefixMessages).toBe(first.messages.length);
  });

  it("retains history when the initial cache-aware drop count is already aligned", async () => {
    const cacheAware = new SlidingWindowStrategy({ cacheAware: true });
    const result = await cacheAware.build({
      events: [
        runInput(0),
        ...Array.from({ length: 8 }, (_, index) =>
          modelResponse(index + 1, `step-${String(index)}`),
        ),
      ],
      budget: { maxTokens: 6, reserveOutputTokens: 0 },
      model,
      counter,
    });

    expect(result.stats.droppedGroups).toBe(4);
    expect(result.messages.map(messageText)).toEqual([
      "goal",
      "[4 earlier steps omitted]",
      "step-4",
      "step-5",
      "step-6",
      "step-7",
    ]);
  });

  it("rejects a zero or negative cache-aware drop chunk", () => {
    expect(() => new SlidingWindowStrategy({ cacheAware: true, dropChunkGroups: 0 })).toThrow(
      RangeError,
    );
  });

  it("estimates each group in linear time", async () => {
    const groupCount = 1000;
    let countCalls = 0;
    const countingCounter: TokenCounter = {
      count: (messages) => {
        countCalls += 1;
        return messages.length;
      },
    };
    const events = [
      runInput(0),
      ...Array.from({ length: groupCount }, (_, index) =>
        modelResponse(index + 1, `response-${String(index)}`),
      ),
    ];

    const result = await strategy.build({
      events,
      budget: { maxTokens: 9, reserveOutputTokens: 0 },
      model,
      counter: countingCounter,
    });

    expect(result.stats.droppedGroups).toBe(groupCount - 7);
    expect(countCalls).toBeLessThan(3 * groupCount);
  });

  it("drops another group when the final full count includes non-additive overhead", async () => {
    const nonAdditiveCounter: TokenCounter = {
      count: (messages) =>
        messages.length === 4 &&
        !messages.some((message) => messageText(message).includes("omitted"))
          ? 6
          : messages.length,
    };

    const result = await strategy.build({
      events: [
        runInput(0),
        modelResponse(1, "old"),
        modelResponse(2, "middle"),
        modelResponse(3, "new"),
      ],
      budget: { maxTokens: 5, reserveOutputTokens: 0 },
      model,
      counter: nonAdditiveCounter,
    });

    expect(result.messages.map(messageText)).toEqual([
      "goal",
      "[1 earlier steps omitted]",
      "middle",
      "new",
    ]);
    expect(result.stats).toMatchObject({ estimatedTokens: 4, droppedGroups: 1 });
  });
});
