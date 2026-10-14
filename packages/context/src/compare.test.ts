// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { type Event, type ModelRef } from "@harness/schemas";
import { compareStrategies, coverage } from "./compare.js";
import { createStrategyRegistry, lookupContextStrategy } from "./registry.js";
import { NaiveStrategy } from "./strategies/naive.js";
import { SlidingWindowStrategy } from "./strategies/sliding-window.js";
import type { Comparison, ContextStrategy, TokenCounter } from "./types.js";

const runId = "00000000000000000000000000";
const previousRunId = "00000000000000000000000001";
const continuationRunId = "00000000000000000000000002";
const segmentId = "11111111111111111111111111";
const model: ModelRef = { provider: "test", model: "test" };
const counter: TokenCounter = { count: (messages) => messages.length };

const envelope = (seq: number) => ({
  runId,
  seq,
  ts: seq,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId,
});

const events: Event[] = [
  { ...envelope(0), type: "run_input", input: "goal", inputKind: "initial" },
  {
    ...envelope(1),
    type: "model_response",
    requestId: "22222222222222222222222222",
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "old" }],
    providerBlobs: null,
  },
  {
    ...envelope(2),
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
    content: [{ type: "text", text: "middle" }],
    providerBlobs: null,
  },
  {
    ...envelope(3),
    type: "model_response",
    requestId: "44444444444444444444444444",
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "newest" }],
    providerBlobs: null,
  },
  {
    ...envelope(4),
    type: "context_compacted",
    fromSeq: 1,
    toSeq: 1,
    strategy: "summarizing",
    strategyVersion: "v1",
    summary: "summary",
  },
];

describe("context strategy comparison", () => {
  it("compares estimates, dropped groups, compacted ranges, and retained sequences", async () => {
    const comparisons = await compareStrategies(
      events,
      [new NaiveStrategy(), new SlidingWindowStrategy()],
      {
        budget: { maxTokens: 3, reserveOutputTokens: 0 },
        model,
        counter,
      },
    );

    expect(comparisons).toMatchObject([
      {
        strategy: "naive",
        strategyVersion: "v5",
        estimatedTokens: 4,
        messageCount: 4,
        droppedGroups: 0,
        compactedRanges: [{ fromSeq: 1, toSeq: 1 }],
        retainedSeqs: [0, 1, 2, 3].map((seq) => ({ runId, seq })),
      },
      {
        strategy: "sliding_window",
        strategyVersion: "v4",
        estimatedTokens: 3,
        messageCount: 3,
        droppedGroups: 2,
        compactedRanges: [{ fromSeq: 1, toSeq: 1 }],
        retainedSeqs: [0, 1].map((seq) => ({ runId, seq })),
      },
    ]);
  });

  it("measures directional coverage and treats an empty target as fully covered", () => {
    const first: Comparison = {
      strategy: "first",
      strategyVersion: "v1",
      estimatedTokens: 1,
      messageCount: 1,
      droppedGroups: 0,
      compactedRanges: [],
      retainedSeqs: [1, 3].map((seq) => ({ runId, seq })),
    };
    const second: Comparison = {
      ...first,
      strategy: "second",
      retainedSeqs: [1, 2, 3].map((seq) => ({ runId, seq })),
    };

    expect(coverage(first, second)).toBeCloseTo(2 / 3);
    expect(coverage(second, first)).toBe(1);
    expect(coverage(first, { ...second, retainedSeqs: [] })).toBe(1);
  });

  it("keeps continuation run identity when measuring coverage", async () => {
    const previousEvents: Event[] = [
      {
        ...envelope(0),
        runId: previousRunId,
        type: "run_input",
        input: "previous goal",
        inputKind: "initial",
      },
      {
        ...envelope(1),
        runId: previousRunId,
        type: "model_response",
        requestId: "22222222222222222222222222",
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [{ type: "text", text: "previous answer" }],
        providerBlobs: null,
      },
    ];
    const continuationEvents: Event[] = [
      {
        ...envelope(0),
        runId: continuationRunId,
        type: "run_input",
        input: "follow-up goal",
        inputKind: "follow_up",
      },
      {
        ...envelope(1),
        runId: continuationRunId,
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
        content: [{ type: "text", text: "follow-up answer" }],
        providerBlobs: null,
      },
    ];
    const [naive, sliding] = await compareStrategies(
      continuationEvents,
      [new NaiveStrategy(), new SlidingWindowStrategy()],
      {
        previousEventLogs: [previousEvents],
        budget: { maxTokens: 3, reserveOutputTokens: 0 },
        model,
        counter,
      },
    );

    expect(naive?.retainedSeqs).toContainEqual({ runId: previousRunId, seq: 0 });
    expect(sliding?.retainedSeqs).not.toContainEqual({ runId: previousRunId, seq: 0 });
    expect(naive).toBeDefined();
    expect(sliding).toBeDefined();
    if (naive === undefined || sliding === undefined) {
      throw new Error("Expected both continuation strategy comparisons.");
    }
    expect(coverage(sliding, naive)).toBeLessThan(1);
  });

  it("looks up only registered strategies", () => {
    const registry = createStrategyRegistry(model);
    expect(lookupContextStrategy(registry, "naive")?.id).toBe("naive");
    expect(lookupContextStrategy(registry, "unknown")).toBeUndefined();
  });

  it("returns an empty result when there are no strategies", async () => {
    await expect(
      compareStrategies(events, [], {
        budget: { maxTokens: 3, reserveOutputTokens: 0 },
        model,
        counter,
      }),
    ).resolves.toEqual([]);
  });

  it("accepts strategy implementations supplied by eval callers", async () => {
    const strategy: ContextStrategy = {
      id: "custom",
      version: "v1",
      build: async (input) => new NaiveStrategy().build(input),
    };
    await expect(
      compareStrategies(events, [strategy], {
        budget: { maxTokens: 100, reserveOutputTokens: 0 },
        model,
        counter,
      }),
    ).resolves.toHaveLength(1);
  });
});
