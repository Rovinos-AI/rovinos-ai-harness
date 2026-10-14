// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseJson, type Event, type Part } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import {
  ContextBudgetSchema,
  NaiveStrategy,
  TranscriptSchema,
  eventsToTranscript,
  type TranscriptGroup,
} from "./index.js";

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const callId = "22222222222222222222222222";
const pendingCallId = "44444444444444444444444444";
const planCallId = "55555555555555555555555555";
const envelope = (seq: number) => ({
  runId,
  seq,
  ts: 100 + seq,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId,
});

function runInput(seq: number, input: Extract<Event, { type: "run_input" }>["input"]): Event {
  return {
    ...envelope(seq),
    type: "run_input",
    input,
    inputKind: "initial",
  };
}

function modelResponse(seq: number, content: Part[]): Event {
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

function toolResult(
  seq: number,
  result: Extract<Event, { type: "tool_result" }>["result"],
  outcome: Extract<Event, { type: "tool_result" }>["outcome"] = "ok",
): Event {
  return {
    ...envelope(seq),
    type: "tool_result",
    callId,
    toolId: "lookup",
    outcome,
    latencyMs: 0,
    result,
  };
}

function planUpdate(seq: number): Event[] {
  const plan = {
    items: [{ id: "task.one", text: "Do the work", status: "doing" }],
    notes: "Keep it",
  };
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

async function readGolden(name: string): Promise<TranscriptGroup[]> {
  const path = fileURLToPath(new URL(`./__golden__/${name}.json`, import.meta.url));
  return parseJson(TranscriptSchema, await readFile(path, "utf8"));
}

describe("eventsToTranscript", () => {
  it("appends continuation logs in order and pins only the newest run input", () => {
    const previousEvents = [
      runInput(0, "original question"),
      modelResponse(1, [{ type: "text", text: "original answer" }]),
    ];
    const followUp = {
      ...envelope(0),
      type: "run_input" as const,
      input: "follow-up question",
      inputKind: "follow_up" as const,
    };

    expect(eventsToTranscript([previousEvents, [followUp]])).toMatchObject([
      { pinned: false, messages: [{ parts: [{ text: "original question" }] }] },
      { pinned: false, messages: [{ parts: [{ text: "original answer" }] }] },
      { pinned: true, messages: [{ parts: [{ text: "follow-up question" }] }] },
    ]);
  });

  it("allows compaction to remove an earlier run input from the continuation chain", () => {
    const previousEvents = [
      runInput(0, "superseded question"),
      modelResponse(1, [{ type: "text", text: "superseded answer" }]),
      {
        ...envelope(2),
        type: "context_compacted" as const,
        fromSeq: 0,
        toSeq: 1,
        strategy: "summary" as const,
        strategyVersion: "v1",
        summary: "the earlier question was answered",
      },
    ];
    const followUp = {
      ...envelope(0),
      type: "run_input" as const,
      input: "new question",
      inputKind: "follow_up" as const,
    };

    expect(eventsToTranscript([previousEvents, [followUp]])).toMatchObject([
      {
        pinned: true,
        messages: [
          { parts: [{ text: "Summary of earlier work: the earlier question was answered" }] },
        ],
      },
      { pinned: true, messages: [{ parts: [{ text: "new question" }] }] },
    ]);
  });

  it.each([
    ["plain-run", [runInput(0, "hello"), modelResponse(1, [{ type: "text", text: "answer" }])]],
    [
      "tool-run",
      [
        runInput(0, "use a tool"),
        modelResponse(1, [
          { type: "text", text: "working" },
          { type: "tool_call", callId, toolId: "lookup", args: { query: "x" } },
        ]),
        toolResult(3, { value: "found" }),
      ],
    ],
    [
      "compacted-run",
      [
        runInput(0, "continue"),
        modelResponse(1, [{ type: "text", text: "earlier" }]),
        modelResponse(2, [{ type: "text", text: "inside range" }]),
        {
          ...envelope(3),
          type: "context_compacted",
          fromSeq: 1,
          toSeq: 2,
          strategy: "summary",
          strategyVersion: "v1",
          summary: "completed the setup",
        },
        modelResponse(4, [{ type: "text", text: "next" }]),
      ],
    ],
    [
      "straddling-tool-compaction",
      [
        runInput(0, "keep the goal"),
        modelResponse(1, [{ type: "tool_call", callId, toolId: "lookup", args: { query: "x" } }]),
        {
          ...envelope(2),
          type: "context_compacted",
          fromSeq: 1,
          toSeq: 1,
          strategy: "summary",
          strategyVersion: "v1",
          summary: "tool call was compacted",
        },
        toolResult(3, { value: "found" }),
      ],
    ],
  ] as const)("matches the %s transcript golden", async (name, events) => {
    const transcript = eventsToTranscript(events);
    if (process.env.UPDATE_GOLDEN === "1") {
      const path = fileURLToPath(new URL(`./__golden__/${name}.json`, import.meta.url));
      await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    }
    expect(transcript).toEqual(await readGolden(name));
  });

  it("matches tool results by call id and keeps calls and results in one group", () => {
    const events: Event[] = [
      toolResult(3, { value: "found" }, "timeout"),
      modelResponse(1, [{ type: "tool_call", callId, toolId: "lookup", args: { query: "x" } }]),
    ];
    const [group] = eventsToTranscript(events);

    expect(group?.seqs).toEqual([1, 3]);
    expect(group?.messages.map(({ role }) => role)).toEqual(["assistant", "tool"]);
    expect(group?.messages[1]?.parts).toMatchObject([{ isError: true }]);
    expect(eventsToTranscript([toolResult(5, null)])).toEqual([]);
    expect(
      eventsToTranscript([
        modelResponse(1, [{ type: "tool_call", callId, toolId: "lookup", args: { query: "x" } }]),
      ]),
    ).toEqual([]);
  });

  it("replaces only intersecting groups and removes a whole atomic tool group", () => {
    const events: Event[] = [
      modelResponse(1, [
        { type: "tool_call", callId, toolId: "lookup", args: { query: "x" } },
        { type: "tool_call", callId: pendingCallId, toolId: "lookup", args: { query: "y" } },
      ]),
      runInput(0, "goal"),
      toolResult(4, { value: "found" }),
      modelResponse(5, [{ type: "text", text: "keep" }]),
      {
        ...envelope(6),
        type: "context_compacted",
        fromSeq: 1,
        toSeq: 1,
        strategy: "summary",
        strategyVersion: "v1",
        summary: "older",
      },
    ];
    const transcript = eventsToTranscript(events);

    expect(transcript).toHaveLength(3);
    expect(transcript.map(({ seqs }) => seqs)).toEqual([[0], [1], [5]]);
    expect(transcript[1]?.messages[0]?.parts).toEqual([
      { type: "text", text: "Summary of earlier work: older" },
    ]);
  });

  it("lets a nested compaction supersede an earlier summary without removing the goal", () => {
    const transcript = eventsToTranscript([
      runInput(0, "keep the goal"),
      modelResponse(1, [{ type: "text", text: "earlier work" }]),
      {
        ...envelope(2),
        type: "context_compacted",
        fromSeq: 1,
        toSeq: 1,
        strategy: "summarizing",
        strategyVersion: "v1",
        summary: "first summary",
      },
      modelResponse(3, [{ type: "text", text: "later work" }]),
      {
        ...envelope(4),
        type: "context_compacted",
        fromSeq: 1,
        toSeq: 3,
        strategy: "summarizing",
        strategyVersion: "v1",
        summary: "replacement summary",
      },
    ]);

    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.messages[0]?.parts).toEqual([{ type: "text", text: "keep the goal" }]);
    expect(transcript[1]?.messages[0]?.parts).toEqual([
      { type: "text", text: "Summary of earlier work: replacement summary" },
    ]);
  });

  it("renders JSON inputs and summaries while pinning the reconstructed input", () => {
    const transcript = eventsToTranscript([
      runInput(0, { goal: "goal" }),
      {
        ...envelope(1),
        type: "context_compacted",
        fromSeq: 0,
        toSeq: 0,
        strategy: "summary",
        strategyVersion: "v1",
        summary: { outcome: "done" },
      },
    ]);

    expect(transcript).toMatchObject([
      {
        seqs: [0],
        pinned: true,
        messages: [{ parts: [{ text: '{"goal":"goal"}' }] }],
      },
      {
        seqs: [0],
        pinned: true,
        messages: [{ parts: [{ text: 'Summary of earlier work: {"outcome":"done"}' }] }],
      },
    ]);
    expect(eventsToTranscript([])).toEqual([]);
    expect(
      eventsToTranscript([
        {
          ...envelope(2),
          type: "run_created",
          configHash: "a".repeat(64),
          policyVersion: "test.policy",
          depth: 0,
        },
      ]),
    ).toEqual([]);
  });
});

describe("NaiveStrategy", () => {
  it("validates the token budget shape", () => {
    expect(ContextBudgetSchema.parse({ maxTokens: 100, reserveOutputTokens: 10 })).toEqual({
      maxTokens: 100,
      reserveOutputTokens: 10,
    });
    expect(ContextBudgetSchema.safeParse({ maxTokens: -1, reserveOutputTokens: 0 }).success).toBe(
      false,
    );
  });

  it("keeps all groups, reports statistics, and pins run inputs", async () => {
    const count = vi.fn(() => 9);
    const strategy = new NaiveStrategy();
    const result = await strategy.build({
      events: [
        runInput(0, "goal"),
        modelResponse(1, [{ type: "tool_call", callId, toolId: "lookup", args: { query: "x" } }]),
        toolResult(2, {
          $offloaded: {
            handle: "wf_00000000000000000000000000",
            bytes: 20,
            preview: "sample",
          },
        }),
        {
          ...envelope(3),
          type: "context_compacted",
          fromSeq: 0,
          toSeq: 0,
          strategy: "summary",
          strategyVersion: "v1",
          summary: "input retained",
        },
      ],
      budget: { maxTokens: 1, reserveOutputTokens: 1 },
      model: { provider: "test", model: "test" },
      counter: { count },
    });

    expect(result.messages).toHaveLength(4);
    expect(
      result.messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text.startsWith("Current plan:")),
      ),
    ).toBe(false);
    expect(result.stats).toEqual({
      messageCount: 4,
      estimatedTokens: 9,
      droppedGroups: 0,
      compactedRanges: 1,
      offloadedResults: 1,
    });
    expect(result.pinnedSeqs).toEqual([0, 0]);
    expect(strategy.id).toBe("naive");
    expect(strategy.version).toBe("v5");
    expect(count).toHaveBeenCalledWith(result.messages, { provider: "test", model: "test" });
  });

  it("appends a plan message when a successful plan update exists", async () => {
    const result = await new NaiveStrategy().build({
      events: [runInput(0, "goal"), ...planUpdate(1)],
      budget: { maxTokens: 100, reserveOutputTokens: 0 },
      model: { provider: "test", model: "test" },
      counter: { count: () => 1 },
    });

    expect(result.messages.at(-1)).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: 'Current plan: {"items":[{"id":"task.one","text":"Do the work","status":"doing"}],"notes":"Keep it"}',
        },
      ],
    });
  });
});
