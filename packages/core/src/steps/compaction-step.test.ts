// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureTracingFallback } from "@harness/telemetry";
import { FakeClock, SequentialIdGenerator, type Event, type ModelRef } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { type TranscriptGroup, SummarizingStrategy } from "@harness/context";
import { RunRecorder, type EventPartial } from "../recorder.js";
import { ModelPortSummarizer, compactionStep, SummarizerResponseError } from "./compaction-step.js";
import { FakeModelPort } from "../testing/fake-model.js";
import type { ModelCompletion, Summarizer } from "../ports.js";
import { RUN_SPAN } from "../spans.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const modelRef: ModelRef = { provider: "test", model: "test" };

beforeAll(() => {
  ensureTracingFallback(
    RUN_SPAN.start({ "harness.run.id": runId, "harness.segment.id": segmentId }),
  );
});

function modelResponse(): EventPartial {
  return {
    type: "model_response",
    v: 1,
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
    content: [{ type: "text", text: "remember <EMAIL_1>" }],
    providerBlobs: null,
  };
}

function historyPartials(responseCount: number): EventPartial[] {
  return [
    { type: "run_created", v: 1, configHash: "a".repeat(64), policyVersion: "test.policy" },
    { type: "run_input", v: 1, input: "goal", inputKind: "initial" },
    ...Array.from({ length: responseCount }, () => modelResponse()),
  ];
}

async function createHistory(responseCount: number): Promise<{
  readonly events: Event[];
  readonly recorder: RunRecorder;
  readonly store: InMemoryEventStore;
}> {
  const store = new InMemoryEventStore();
  const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(100));
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch(historyPartials(responseCount));
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected seeded events.");
    }
    return last;
  });
  return { events, recorder, store };
}

async function recordMore(recorder: RunRecorder, count: number): Promise<Event[]> {
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch(Array.from({ length: count }, () => modelResponse()));
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected additional events.");
    }
    return last;
  });
  return events;
}

function successfulCompletion(text: string): ModelCompletion {
  return {
    parts: [{ type: "text", text }],
    usage: { inputTokens: 7, outputTokens: 3 },
    finishReason: "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

describe("compactionStep", () => {
  it("summarizes only the oldest non-pinned groups and records one event in-range", async () => {
    const { events, recorder, store } = await createHistory(8);
    const record = vi.spyOn(recorder, "record");
    const summarized: { readonly groups: readonly TranscriptGroup[]; readonly goal: string }[] = [];
    const summarize = vi.fn<Summarizer["summarize"]>((input) => {
      summarized.push(input);
      return Promise.resolve({
        text: "summary alice@example.test",
        usage: { inputTokens: 8, outputTokens: 2 },
      });
    });
    const summarizer: Summarizer = { summarize };
    const sanitizeSummary = vi.fn((text: string) =>
      Promise.resolve(text.replace("alice@example.test", "<EMAIL_1>")),
    );

    const compacted = await compactionStep({
      recorder,
      events,
      strategy: new SummarizingStrategy(modelRef),
      summarizer,
      budget: { maxTokens: 100, reserveOutputTokens: 0 },
      counter: { count: () => 100 },
      goal: "goal",
      sanitizeSummary,
      keepRecentGroups: 2,
    });

    expect(compacted).toMatchObject({
      type: "context_compacted",
      fromSeq: 2,
      toSeq: 7,
      strategy: "summarizing",
      strategyVersion: "v1",
      summary: "summary <EMAIL_1>",
    });
    expect(summarized).toHaveLength(1);
    expect(summarized[0]?.goal).toBe("goal");
    expect(summarized[0]?.groups).toHaveLength(6);
    expect(summarized[0]?.groups.every((group) => !group.pinned)).toBe(true);
    expect(summarized[0]?.groups.map((group) => group.seqs[0])).toEqual([2, 3, 4, 5, 6, 7]);
    expect(JSON.stringify(summarized[0]?.groups)).toContain("<EMAIL_1>");
    expect(record).toHaveBeenCalledOnce();
    expect(sanitizeSummary).toHaveBeenCalledOnce();
    const stored: Event[] = [];
    for await (const event of store.read(runId)) {
      stored.push(event);
    }
    expect(stored.filter((event) => event.type === "context_compacted")).toHaveLength(1);
  });

  it("starts new ranges after previous compactions without reusing compacted groups", async () => {
    const { events, recorder } = await createHistory(8);
    const strategy = new SummarizingStrategy(modelRef);
    const summarizer: Summarizer = {
      summarize: () =>
        Promise.resolve({ text: "summary", usage: { inputTokens: 8, outputTokens: 2 } }),
    };
    const sanitizeSummary = (text: string): Promise<string> => Promise.resolve(text);
    const first = await compactionStep({
      recorder,
      events,
      strategy,
      summarizer,
      budget: { maxTokens: 100, reserveOutputTokens: 0 },
      counter: { count: () => 100 },
      goal: "goal",
      sanitizeSummary,
      keepRecentGroups: 2,
    });
    if (first?.type !== "context_compacted") {
      throw new Error("Expected the first compaction.");
    }
    const laterEvents = await recordMore(recorder, 3);
    const second = await compactionStep({
      recorder,
      events: [...events, first, ...laterEvents],
      strategy,
      summarizer,
      budget: { maxTokens: 100, reserveOutputTokens: 0 },
      counter: { count: () => 100 },
      goal: "goal",
      sanitizeSummary,
      keepRecentGroups: 1,
    });

    expect(second).toMatchObject({
      type: "context_compacted",
      fromSeq: first.toSeq + 1,
      toSeq: 12,
    });
  });

  it("does not invoke the summarizer when below threshold or with no eligible groups", async () => {
    const { events, recorder } = await createHistory(1);
    const summarize = () => Promise.reject(new Error("should not summarize"));
    const options = {
      recorder,
      events,
      strategy: new SummarizingStrategy(modelRef),
      summarizer: { summarize },
      budget: { maxTokens: 100, reserveOutputTokens: 0 },
      counter: { count: () => 1 },
      goal: "goal",
      sanitizeSummary: (text: string) => Promise.resolve(text),
    };
    await expect(compactionStep(options)).resolves.toBeUndefined();
    await expect(
      compactionStep({
        ...options,
        counter: { count: () => 100 },
        keepRecentGroups: 6,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid recent-group limits", async () => {
    const { events, recorder } = await createHistory(1);
    await expect(
      compactionStep({
        recorder,
        events,
        strategy: new SummarizingStrategy(modelRef),
        summarizer: {
          summarize: () =>
            Promise.resolve({ text: "summary", usage: { inputTokens: 0, outputTokens: 0 } }),
        },
        budget: { maxTokens: 100, reserveOutputTokens: 0 },
        counter: { count: () => 0 },
        goal: "goal",
        sanitizeSummary: (text: string) => Promise.resolve(text),
        keepRecentGroups: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("ModelPortSummarizer", () => {
  it("requests the summarizer role and retains existing tokens in model input", async () => {
    const model = new FakeModelPort([successfulCompletion("summary")]);
    const summarizer = new ModelPortSummarizer(model, new SequentialIdGenerator(), modelRef, {
      runId,
      signal: new AbortController().signal,
    });

    await expect(
      summarizer.summarize({
        groups: [
          {
            seqs: [1],
            pinned: false,
            messages: [{ role: "user", parts: [{ type: "text", text: "email <EMAIL_1>" }] }],
          },
        ],
        goal: "goal",
      }),
    ).resolves.toMatchObject({ text: "summary", usage: { inputTokens: 7, outputTokens: 3 } });

    const request = model.requests[0]?.request;
    expect(request?.role).toBe("summarizer");
    expect(JSON.stringify(request?.messages)).toContain("<EMAIL_1>");
    expect(JSON.stringify(request?.messages)).toContain("open tasks");
  });

  it("rejects completions without text", async () => {
    const model = new FakeModelPort([successfulCompletion("")]);
    const summarizer = new ModelPortSummarizer(model, new SequentialIdGenerator(), modelRef, {
      runId,
      signal: new AbortController().signal,
    });

    await expect(summarizer.summarize({ groups: [], goal: "goal" })).rejects.toBeInstanceOf(
      SummarizerResponseError,
    );
  });
});
