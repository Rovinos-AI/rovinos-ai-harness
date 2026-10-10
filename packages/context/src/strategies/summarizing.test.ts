// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { type Event, type ModelRef } from "@harness/schemas";
import type { ContextStrategyInput, TokenCounter } from "../types.js";
import { SummarizingStrategy } from "./summarizing.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const model: ModelRef = { provider: "test", model: "test" };

const envelope = (seq: number) => ({
  runId,
  seq,
  ts: 100 + seq,
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
    content: [{ type: "text", text: "earlier <EMAIL_1>" }],
    providerBlobs: null,
  },
];

function input(counter: TokenCounter): ContextStrategyInput {
  return {
    events,
    budget: { maxTokens: 4, reserveOutputTokens: 0 },
    model,
    counter,
  };
}

describe("SummarizingStrategy", () => {
  it("triggers strictly above the configured fraction of the available budget", () => {
    const strategy = new SummarizingStrategy(model);
    const counter = (estimate: number): TokenCounter => ({ count: () => estimate });

    expect(
      strategy.needsCompaction(events, { maxTokens: 100, reserveOutputTokens: 0 }, counter(74)),
    ).toBe(false);
    expect(
      strategy.needsCompaction(events, { maxTokens: 100, reserveOutputTokens: 0 }, counter(75)),
    ).toBe(false);
    expect(
      strategy.needsCompaction(events, { maxTokens: 100, reserveOutputTokens: 0 }, counter(76)),
    ).toBe(true);
    expect(
      strategy.needsCompaction(events, { maxTokens: 100, reserveOutputTokens: 20 }, counter(61)),
    ).toBe(true);
  });

  it("uses the sliding-window fallback and never invokes a summarizer while building", async () => {
    const summarize = vi.fn(() => {
      throw new Error("build must not summarize");
    });
    const strategy = new SummarizingStrategy(model);
    const result = await strategy.build(input({ count: () => 3 }));

    expect(result.messages).toHaveLength(2);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects trigger ratios outside the interval (0, 1]", () => {
    expect(() => new SummarizingStrategy(model, { triggerRatio: 0 })).toThrow(RangeError);
    expect(() => new SummarizingStrategy(model, { triggerRatio: 1.1 })).toThrow(RangeError);
    expect(() => new SummarizingStrategy(model, { triggerRatio: Number.NaN })).toThrow(RangeError);
  });
});
