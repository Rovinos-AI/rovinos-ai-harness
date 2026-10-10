// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureTracingFallback } from "@harness/telemetry";
import { FakeClock, SequentialIdGenerator, type Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { SummarizingStrategy } from "@harness/context";
import { RunRecorder } from "./recorder.js";
import { runLoop } from "./loop.js";
import { resumeRun } from "./resume.js";
import { RUN_SPAN } from "./spans.js";
import { CrashingEventStore, SimulatedCrash } from "./testing/crash-store.js";
import { FakeModelPort, FakeToolPort } from "./testing/index.js";
import type { ModelCompletion, Summarizer } from "./ports.js";
import { NaiveContext } from "./context/naive-context.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const configHash = "a".repeat(64);
const callId = "22222222222222222222222222";
const modelRef = { provider: "test_provider", model: "test_model" };

beforeAll(() => {
  ensureTracingFallback(
    RUN_SPAN.start({ "harness.run.id": runId, "harness.segment.id": segmentId }),
  );
});

function completion(withToolCall: boolean): ModelCompletion {
  return {
    parts: withToolCall
      ? [
          { type: "text", text: "calling lookup" },
          { type: "tool_call", callId, toolId: "lookup", args: { query: "x" } },
        ]
      : [{ type: "text", text: "finished" }],
    usage: { inputTokens: 2, outputTokens: 1 },
    finishReason: "stop",
    provider: modelRef.provider,
    model: modelRef.model,
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

async function readEvents(store: InMemoryEventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("compaction crash recovery", () => {
  it.each(["before_commit", "after_commit"] as const)(
    "resumes correctly when context_compacted crashes %s",
    async (mode) => {
      const inner = new InMemoryEventStore();
      const store = new CrashingEventStore(inner, { crashAt: 6, mode });
      const clock = new FakeClock(100);
      const ids = new SequentialIdGenerator();
      const model = new FakeModelPort([completion(true), completion(false)]);
      const summarize = vi.fn<Summarizer["summarize"]>(() =>
        Promise.resolve({
          text: "durable summary",
          usage: { inputTokens: 4, outputTokens: 2, costMicros: 3 },
        }),
      );
      const tool = new FakeToolPort(
        new Map([
          [
            "lookup",
            {
              idempotent: true,
              timeoutMs: 100,
              execute: () => Promise.resolve({ outcome: "ok", result: { value: "found" } }),
            },
          ],
        ]),
      );
      const context = new NaiveContext();
      const compaction = {
        strategy: new SummarizingStrategy(modelRef),
        summarizer: { summarize },
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text: string) => Promise.resolve(text),
        keepRecentGroups: 0,
      };

      await expect(
        runLoop({
          recorder: new RunRecorder(store, runId, segmentId, 0, clock),
          clock,
          model,
          tool,
          context,
          ids,
          goal: "recover compaction",
          configHash,
          budgets: {
            maxSteps: 10,
            maxWallClockMs: 60_000,
            countSuspendedTime: false,
          },
          policyVersion: "test.policy",
          signal: new AbortController().signal,
          compaction,
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(summarize).toHaveBeenCalledOnce();

      const resumed = await resumeRun({
        store,
        runId,
        clock,
        model,
        tool,
        context,
        ids,
        goal: "recover compaction",
        budgets: {
          maxSteps: 10,
          maxWallClockMs: 60_000,
          countSuspendedTime: false,
        },
        signal: new AbortController().signal,
        compaction,
      });
      const events = await readEvents(inner);

      expect(resumed.status).toBe("completed");
      expect(events.filter((event) => event.type === "context_compacted")).toHaveLength(1);
      expect(events.filter((event) => event.type === "model_response")).toHaveLength(2);
      expect(resumed.state.usage).toEqual({ inputTokens: 8, outputTokens: 4, costMicros: 3 });
      expect(summarize).toHaveBeenCalledTimes(mode === "before_commit" ? 2 : 1);
      await inner.close();
    },
  );
});
