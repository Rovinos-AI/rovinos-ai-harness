// SPDX-License-Identifier: Apache-2.0
import { Code, Event, Id, type Event as EventValue } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { diffRuns, normalizeRun } from "./diff.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const firstRunId = Id.parse("00000000000000000000000001");
const secondRunId = Id.parse("00000000000000000000000002");
const firstChildId = Id.parse("00000000000000000000000003");
const secondChildId = Id.parse("00000000000000000000000004");

function runCreated(runId: Id, ts: number, replayOf?: Id): EventValue {
  return Event.parse({
    runId,
    seq: 0,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: Code.parse("policy.test"),
    ...(replayOf === undefined ? {} : { replayOf }),
  });
}

function statusEvent(to: "running" | "suspended" | "completed" | "failed", seq = 1): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq,
    ts: seq + 1,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "run_status_changed",
    from: "running",
    to,
    reason: "test",
  });
}

function subagentEvent(childRunId: Id, seq = 1): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq,
    ts: seq + 1,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "subagent_spawned",
    childRunId,
    role: "worker",
  });
}

function modelResponse(
  latencyMs: number,
  repairAttempts = 0,
  costMicros?: number,
  content = "synthetic response",
): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "model_response",
    requestId: Id.parse("00000000000000000000000005"),
    provider: "synthetic",
    model: "synthetic",
    inputTokens: 1,
    outputTokens: 1,
    ...(costMicros === undefined ? {} : { costMicros }),
    finishReason: "stop",
    latencyMs,
    schemaValid: true,
    repairAttempts,
    content: [{ type: "text", text: content }],
    providerBlobs: { canary: content },
  });
}

function subagentCompleted(costMicros: number): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "subagent_completed",
    childRunId: firstChildId,
    outcome: "completed",
    inputTokens: 1,
    outputTokens: 1,
    costMicros,
  });
}

function toolResult(
  toolId: string,
  outcome: "ok" | "error",
  errorCode = "tool_failed",
): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "tool_result",
    callId: Id.parse("00000000000000000000000007"),
    toolId: Code.parse(toolId),
    outcome,
    errorCode,
    latencyMs: 10,
    result: { synthetic: true },
  });
}

function toolIntent(policyDecision: "allow" | "ask" | "deny"): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "tool_intent",
    callId: Id.parse("00000000000000000000000008"),
    toolId: Code.parse("synthetic.tool"),
    idempotent: true,
    policyDecision,
    argsHash: "a".repeat(64),
    args: { synthetic: true },
  });
}

function approvalResolved(
  waitMs: number,
  edit: string,
  decision: "approve" | "deny" = "approve",
): EventValue {
  return Event.parse({
    runId: firstRunId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: firstRunId,
    type: "approval_resolved",
    approvalId: Id.parse("00000000000000000000000006"),
    decision,
    decidedBy: "policy",
    waitMs,
    edits: { canary: edit },
  });
}

function contentEvent(
  runId: Id,
  seq: number,
  type: "run_input" | "context_compacted",
  canary: string,
): EventValue {
  const envelope = { runId, seq, ts: seq + 1, v: 1, traceId, spanId, segmentId: runId };
  if (type === "run_input") {
    return Event.parse({
      ...envelope,
      type,
      input: canary,
      inputKind: "initial",
    });
  }
  return Event.parse({
    ...envelope,
    type,
    fromSeq: 0,
    toSeq: seq,
    strategy: "synthetic",
    strategyVersion: "v1",
    summary: { canary },
  });
}

describe("normalizeRun", () => {
  it("drops volatile ids and timestamps and aliases identifiers by first appearance", () => {
    const first = [runCreated(firstRunId, 10, secondRunId), subagentEvent(firstChildId)];
    const second = [runCreated(secondRunId, 100, firstRunId), subagentEvent(secondChildId)];

    expect(normalizeRun(first)).toEqual(normalizeRun(second));
    expect(diffRuns(first, second)).toMatchObject({ identical: true, entries: [] });
    expect(normalizeRun(first)).toMatchObject([
      { kind: "run_created", replayOf: "run#1" },
      { kind: "subagent_spawned", childRunId: "childRun#1" },
    ]);
  });

  it("represents events without a safe projection using only their type", () => {
    const input = contentEvent(firstRunId, 0, "run_input", "CANARY-RUN-INPUT");

    expect(normalizeRun([input])).toEqual([{ kind: "run_input" }]);
  });
});

describe("diffRuns", () => {
  it("returns no differences for identical logs", () => {
    const events = [runCreated(firstRunId, 1), statusEvent("completed")];

    expect(diffRuns(events, events)).toMatchObject({
      identical: true,
      summary: { added: 0, removed: 0, changed: 0, behavioral: 0, noise: 0 },
      approximate: false,
      entries: [],
    });
  });

  it("reports additions, removals, and changed metadata", () => {
    expect(
      diffRuns([statusEvent("running")], [statusEvent("running"), statusEvent("completed")]),
    ).toMatchObject({
      summary: { added: 1, removed: 0 },
      entries: [{ kind: "added", index: 1, eventKind: "run_status" }],
    });

    expect(
      diffRuns([statusEvent("running"), statusEvent("completed")], [statusEvent("running")]),
    ).toMatchObject({
      summary: { added: 0, removed: 1 },
      entries: [{ kind: "removed", index: 1, eventKind: "run_status" }],
    });

    expect(diffRuns([statusEvent("running")], [statusEvent("failed")])).toMatchObject({
      identical: false,
      summary: { changed: 1, behavioral: 1 },
      entries: [
        {
          kind: "changed",
          eventKind: "run_status",
          fields: [{ field: "to", a: "running", b: "failed" }],
          class: "behavioral",
        },
      ],
    });
  });

  it("uses LCS alignment to isolate an inserted event", () => {
    const result = diffRuns(
      [statusEvent("running", 0), statusEvent("completed", 1)],
      [statusEvent("running", 0), statusEvent("suspended", 1), statusEvent("completed", 2)],
    );

    expect(result.summary).toMatchObject({ added: 1, removed: 0, changed: 0 });
    expect(result.entries).toMatchObject([
      { kind: "added", index: 1, eventKind: "run_status", class: "behavioral" },
    ]);
  });

  const behavioralCases: readonly [string, EventValue, EventValue][] = [
    ["tool id", toolResult("synthetic.one", "ok"), toolResult("synthetic.two", "ok")],
    ["tool outcome", toolResult("synthetic.tool", "ok"), toolResult("synthetic.tool", "error")],
    [
      "error code",
      toolResult("synthetic.tool", "error", "first_error"),
      toolResult("synthetic.tool", "error", "second_error"),
    ],
    [
      "approval decision",
      approvalResolved(10, "synthetic", "approve"),
      approvalResolved(10, "synthetic", "deny"),
    ],
    ["policy decision", toolIntent("allow"), toolIntent("deny")],
  ];

  it.each(behavioralCases)("classifies %s differences as behavioral", (_field, eventA, eventB) => {
    expect(diffRuns([eventA], [eventB])).toMatchObject({
      identical: false,
      summary: { behavioral: 1, noise: 0 },
      entries: [{ kind: "changed", class: "behavioral" }],
    });
  });

  const noiseCases: readonly [string, number, number, boolean, "noise" | "behavioral"][] = [
    ["latencyMs", 10, 20, false, "noise"],
    ["waitMs", 10, 20, false, "noise"],
    ["costMicros", 10, 20, false, "behavioral"],
    ["repairAttempts", 0, 1, false, "behavioral"],
    ["costMicros", 10, 20, true, "noise"],
    ["repairAttempts", 0, 1, true, "noise"],
  ];

  it.each(noiseCases)(
    "classifies %s differences between %s and %s with ignoreMetrics=%s as %s",
    (field, valueA, valueB, ignoreMetrics, expectedClass) => {
      const makeEvent = (value: number): EventValue => {
        if (field === "waitMs") {
          return approvalResolved(value, "synthetic");
        }
        if (field === "costMicros") {
          return subagentCompleted(value);
        }
        return modelResponse(
          field === "latencyMs" ? value : 10,
          field === "repairAttempts" ? value : 0,
        );
      };
      const result = diffRuns([makeEvent(valueA)], [makeEvent(valueB)], { ignoreMetrics });

      expect(result.entries).toMatchObject([{ kind: "changed", class: expectedClass }]);
      expect(result.summary.noise).toBe(expectedClass === "noise" ? 1 : 0);
      expect(result.identical).toBe(expectedClass === "noise");
    },
  );

  it("supports caller-selected ignored fields", () => {
    expect(
      diffRuns([modelResponse(10)], [modelResponse(20)], {
        ignoreFields: [Code.parse("latency_ms")],
      }),
    ).toMatchObject({ identical: true, entries: [] });
  });

  it("uses positional alignment and marks results approximate above the LCS cap", () => {
    const events = Array.from({ length: 5_001 }, () => statusEvent("running"));

    expect(diffRuns(events, events)).toMatchObject({
      identical: true,
      approximate: true,
      entries: [],
    });
  });

  it("never includes content canaries in normalized diffs", () => {
    const canariesA = [
      contentEvent(firstRunId, 0, "run_input", "CANARY-ALPHA"),
      modelResponse(10, 0, undefined, "CANARY-BETA"),
      approvalResolved(10, "CANARY-GAMMA"),
      contentEvent(firstRunId, 3, "context_compacted", "CANARY-DELTA"),
    ];
    const canariesB = [
      contentEvent(secondRunId, 0, "run_input", "CANARY-OMEGA"),
      modelResponse(10, 0, undefined, "CANARY-THETA"),
      approvalResolved(10, "CANARY-SIGMA"),
      contentEvent(secondRunId, 3, "context_compacted", "CANARY-TAU"),
    ];
    const result = diffRuns(canariesA, canariesB);

    expect(JSON.stringify({ normalized: normalizeRun(canariesA), result })).not.toMatch(
      /CANARY-(?:ALPHA|BETA|GAMMA|DELTA|OMEGA|THETA|SIGMA|TAU)/u,
    );
    expect(result.identical).toBe(true);
  });
});
