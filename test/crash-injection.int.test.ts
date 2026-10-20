// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClock,
  Code,
  Id,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type JsonValue,
  type Message,
  type NewEvent,
  type Part,
} from "@harness/schemas";
import {
  createRuntime,
  NaiveContext,
  resumeRun,
  resolveApproval,
  RunAlreadyTerminalError,
  RunRecorder,
  RUN_SPAN,
  runLoop,
  type ContextPort,
  type IdGenerator,
  type ModelCompletion,
  type ModelPort,
  type ModelRequest,
  type PolicyPort,
  type ToolPort,
} from "@harness/core";
import { SummarizingStrategy } from "@harness/context";
import {
  CrashingEventStore,
  FakeModelPort,
  allowAllPolicy,
  FakeToolPort,
  SimulatedCrash,
  type FakeModelOptions,
  type FakeToolDefinition,
} from "@harness/core/testing";
import type { EventStore } from "@harness/store";
import { SqliteEventStore } from "@harness/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureTracingFallback } from "@harness/telemetry";

const config = {
  run: RunConfigSchema.parse({
    checkpointEveryEvents: 3,
    resume: { onNonIdempotent: "escalate" },
  }),
};
const goal: JsonValue = "crash matrix";
const runId = Id.parse("00000000000000000000000000");
const nonIdempotentCallId = Id.parse("00000000000000000000000010");
const idempotentCallId = Id.parse("00000000000000000000000011");
const nonIdempotentToolId = "write_once";
const idempotentToolId = "safe_retry";

interface EffectCounts {
  nonIdempotent: number;
  idempotent: number;
}

interface Scenario {
  readonly model: FakeModelPort;
  readonly tool: FakeToolPort;
  readonly counts: EffectCounts;
  readonly context: ContextPort;
}

interface Reference {
  readonly appendCount: number;
  readonly boundaries: readonly AppendBoundary[];
  readonly events: readonly Event[];
  readonly semantic: readonly SemanticEvent[];
}

interface AppendBoundary {
  readonly runId: Id;
  readonly method: "append" | "appendWithSnapshot" | "appendWithUsage";
  readonly eventTypes: readonly Event["type"][];
  readonly callIds: readonly Id[];
}

type SemanticEvent =
  | { readonly type: "model_response"; readonly content: ModelCompletion["parts"] }
  | {
      readonly type: "tool_result";
      readonly toolId: string;
      readonly outcome: string;
      readonly result: JsonValue;
      readonly errorCode?: string;
    };

function idsAfter(offset: number): IdGenerator {
  const ids = new SequentialIdGenerator();
  for (let index = 0; index < offset; index += 1) {
    ids.next();
  }
  return ids;
}

function idAt(offset: number): Id {
  return Id.parse(idsAfter(offset).next());
}

function positionFromRequest(request: ModelRequest): number {
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.type !== "text") {
        continue;
      }
      const match = /^position:(\d+)$/.exec(part.text);
      if (match !== null) {
        const position = Number(match[1]);
        if (Number.isSafeInteger(position)) {
          return position;
        }
      }
    }
  }
  return 0;
}

function createScenario(): Scenario {
  const counts: EffectCounts = { nonIdempotent: 0, idempotent: 0 };
  const call = {
    callId: nonIdempotentCallId,
    toolId: nonIdempotentToolId,
    args: { value: "synthetic" },
  };
  const replayableCall = {
    callId: idempotentCallId,
    toolId: idempotentToolId,
    args: { value: "synthetic" },
  };
  const completion = (
    content: string,
    toolCalls: readonly {
      readonly callId: Id;
      readonly toolId: string;
      readonly args: JsonValue;
    }[] = [],
  ): ModelCompletion => ({
    parts: [
      { type: "text", text: content },
      ...toolCalls.map((toolCall): Part => ({ type: "tool_call", ...toolCall })),
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "fake",
    model: "script",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  });
  const fakeOptions: FakeModelOptions = {
    responseIndex: (request) => Math.min(positionFromRequest(request), 2),
  };
  const model = new FakeModelPort(
    [
      completion("non-idempotent request", [call]),
      completion("idempotent request", [replayableCall]),
      completion("final answer"),
    ],
    fakeOptions,
  );
  const definitions = new Map<string, FakeToolDefinition>([
    [
      nonIdempotentToolId,
      {
        idempotent: false,
        timeoutMs: 1_000,
        execute: () => {
          counts.nonIdempotent += 1;
          return Promise.resolve({ outcome: "ok", result: { effect: "written" } });
        },
      },
    ],
    [
      idempotentToolId,
      {
        idempotent: true,
        timeoutMs: 1_000,
        execute: () => {
          counts.idempotent += 1;
          return Promise.resolve({ outcome: "ok", result: { effect: "safe" } });
        },
      },
    ],
  ]);
  const tool = new FakeToolPort(definitions);
  const context: ContextPort = {
    build: (events) => {
      const messages: Message[] = [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: `position:${String(events.filter((event) => event.type === "model_response").length)}`,
            },
          ],
        },
      ];
      return Promise.resolve({
        messages,
        metadata: {
          strategyId: "naive",
          strategyVersion: "v5",
          estimatedTokens: 1,
          messageCount: 1,
          stablePrefixMessages: 0,
        },
      });
    },
    snapshot: () => Promise.resolve(null),
    restore: () => Promise.resolve(),
  };
  return { model, tool, counts, context };
}

function modelOptions(scenario: Scenario, store: EventStore, ids: IdGenerator) {
  return {
    store,
    clock: new FakeClock(100),
    ids,
    model: scenario.model,
    tool: scenario.tool,
    context: scenario.context,
    policy: allowAllPolicy,
  };
}

async function readEvents(store: EventStore, forRun: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(forRun)) {
    events.push(event);
  }
  return events;
}

class BoundaryRecordingStore implements EventStore {
  readonly boundaries: AppendBoundary[] = [];

  constructor(private readonly inner: EventStore) {}

  append(
    forRun: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    this.boundaries.push({
      runId: forRun,
      method: "append",
      eventTypes: events.map(({ type }) => type),
      callIds: events.flatMap((event) =>
        event.type === "tool_intent" ||
        event.type === "tool_execution_started" ||
        event.type === "tool_result"
          ? [event.callId]
          : [],
      ),
    });
    return this.inner.append(forRun, events, expectedSeq, leaseOwner);
  }

  appendWithSnapshot(
    forRun: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Parameters<EventStore["appendWithSnapshot"]>[3],
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    this.boundaries.push({
      runId: forRun,
      method: "appendWithSnapshot",
      eventTypes: events.map(({ type }) => type),
      callIds: events.flatMap((event) =>
        event.type === "tool_intent" ||
        event.type === "tool_execution_started" ||
        event.type === "tool_result"
          ? [event.callId]
          : [],
      ),
    });
    return this.inner.appendWithSnapshot(forRun, events, expectedSeq, snapshot, leaseOwner);
  }

  appendWithUsage(...args: Parameters<EventStore["appendWithUsage"]>) {
    const [forRun, events, expectedSeq, options] = args;
    this.boundaries.push({
      runId: forRun,
      method: "appendWithUsage",
      eventTypes: events.map(({ type }) => type),
      callIds: [],
    });
    return this.inner.appendWithUsage(forRun, events, expectedSeq, options);
  }

  readUsageLedger(...args: Parameters<EventStore["readUsageLedger"]>) {
    return this.inner.readUsageLedger(...args);
  }

  claimRunExecution(...args: Parameters<EventStore["claimRunExecution"]>) {
    return this.inner.claimRunExecution(...args);
  }

  renewRunExecution(...args: Parameters<EventStore["renewRunExecution"]>) {
    return this.inner.renewRunExecution(...args);
  }

  releaseRunExecution(...args: Parameters<EventStore["releaseRunExecution"]>) {
    return this.inner.releaseRunExecution(...args);
  }

  latestSnapshot(forRun: Id) {
    return this.inner.latestSnapshot(forRun);
  }

  retainedSnapshots(forRun: Id, limit: number) {
    return this.inner.retainedSnapshots(forRun, limit);
  }

  read(forRun: Id, range?: Parameters<EventStore["read"]>[1]) {
    return this.inner.read(forRun, range);
  }

  watch(...args: Parameters<EventStore["watch"]>) {
    return this.inner.watch(...args);
  }

  watchRuns(...args: Parameters<EventStore["watchRuns"]>) {
    return this.inner.watchRuns(...args);
  }

  head(forRun: Id) {
    return this.inner.head(forRun);
  }

  deleteRun(forRun: Id) {
    return this.inner.deleteRun(forRun);
  }

  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    return this.inner.consumeConfirmationState(stateId, expiresAt, now);
  }

  claimIdempotencyKey(
    keyHash: Parameters<EventStore["claimIdempotencyKey"]>[0],
    candidateRunId: Id,
    createdAt: number,
  ) {
    return this.inner.claimIdempotencyKey(keyHash, candidateRunId, createdAt);
  }

  takeoverIdempotencyKey(
    ...args: Parameters<EventStore["takeoverIdempotencyKey"]>
  ): ReturnType<EventStore["takeoverIdempotencyKey"]> {
    return this.inner.takeoverIdempotencyKey(...args);
  }

  releaseIdempotencyKey(
    keyHash: Parameters<EventStore["releaseIdempotencyKey"]>[0],
    claimedRunId: Id,
  ) {
    return this.inner.releaseIdempotencyKey(keyHash, claimedRunId);
  }

  listRuns(options: Parameters<EventStore["listRuns"]>[0]) {
    return this.inner.listRuns(options);
  }

  findRunsByTrace(traceId: Parameters<EventStore["findRunsByTrace"]>[0]) {
    return this.inner.findRunsByTrace(traceId);
  }

  fetchOutbox(sinkId: Code, limit: number) {
    return this.inner.fetchOutbox(sinkId, limit);
  }

  ackOutbox(sinkId: Code, cursor: number) {
    return this.inner.ackOutbox(sinkId, cursor);
  }

  claimApprovalNotification(approvalId: Id, approvalRunId: Id, claimedAt: number, leaseMs: number) {
    return this.inner.claimApprovalNotification(approvalId, approvalRunId, claimedAt, leaseMs);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    approvalRunId: Id,
    claimedAt: number,
    sentAt: number,
  ) {
    return this.inner.markApprovalNotificationSent(approvalId, approvalRunId, claimedAt, sentAt);
  }

  releaseApprovalNotification(approvalId: Id, approvalRunId: Id, claimedAt: number) {
    return this.inner.releaseApprovalNotification(approvalId, approvalRunId, claimedAt);
  }

  close() {
    return this.inner.close();
  }
}

function semanticEvents(events: readonly Event[]): SemanticEvent[] {
  const semantic: SemanticEvent[] = [];
  for (const event of events) {
    if (event.type === "model_response") {
      semantic.push({ type: event.type, content: event.content });
      continue;
    }
    if (event.type === "tool_result") {
      semantic.push({
        type: event.type,
        toolId: event.toolId,
        outcome: event.outcome,
        result: event.result,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      });
    }
  }
  return semantic;
}

function danglingIntent(events: readonly Event[], callId: Id): boolean {
  const intent = events.some((event) => event.type === "tool_intent" && event.callId === callId);
  const result = events.some((event) => event.type === "tool_result" && event.callId === callId);
  return intent && !result;
}

function hasUnrecordedProposedCall(events: readonly Event[]): Id | undefined {
  for (const event of events) {
    if (event.type !== "model_response") {
      continue;
    }
    for (const part of event.content) {
      if (part.type !== "tool_call") {
        continue;
      }
      if (
        !events.some(
          (candidate) => candidate.type === "tool_intent" && candidate.callId === part.callId,
        )
      ) {
        return part.callId;
      }
    }
  }
  return undefined;
}

function hasUnrecordedFinalStatus(events: readonly Event[]): boolean {
  const finalAnswerRecorded = events.some(
    (event) =>
      event.type === "model_response" &&
      event.content.some((part) => part.type === "text" && part.text === "final answer"),
  );
  const completed = events.some(
    (event) => event.type === "run_status_changed" && event.to === "completed",
  );
  return finalAnswerRecorded && !completed;
}

function hasReplayedFinalResponse(events: readonly Event[]): boolean {
  return (
    events.filter(
      (event) =>
        event.type === "model_response" &&
        event.content.some((part) => part.type === "text" && part.text === "final answer"),
    ).length > 1
  );
}

function isResumeAmbiguityPayload(payload: JsonValue | undefined): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    payload.kind === "resume_ambiguity"
  );
}

async function discoverReference(directory: string): Promise<Reference> {
  const database = new SqliteEventStore(join(directory, "reference.sqlite"));
  const boundaries = new BoundaryRecordingStore(database);
  const scenario = createScenario();
  const runtime = await createRuntime(
    config,
    modelOptions(
      scenario,
      new CrashingEventStore(boundaries, {
        crashAt: Number.MAX_SAFE_INTEGER,
        mode: "before_commit",
      }),
      idsAfter(0),
    ),
  );
  try {
    const result = await runtime.run(goal);
    const events = await readEvents(boundaries, runId);
    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "checkpoint_written")).toBe(true);
    expect(boundaries.boundaries.some(({ method }) => method === "appendWithSnapshot")).toBe(true);
    expect(scenario.counts).toEqual({ nonIdempotent: 1, idempotent: 1 });
    return {
      appendCount: boundaries.boundaries.length,
      boundaries: boundaries.boundaries,
      events,
      semantic: semanticEvents(events),
    };
  } finally {
    await runtime.close();
  }
}

class PreIntentExecutionStore implements EventStore {
  constructor(
    private readonly inner: EventStore,
    private readonly tool: FakeToolPort,
  ) {}

  async append(
    forRun: Id,
    events: readonly Parameters<EventStore["append"]>[1][number][],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    for (const event of events) {
      if (event.type === "tool_intent") {
        await this.tool.execute(
          { callId: event.callId, toolId: event.toolId, args: event.args },
          { runId: forRun, signal: new AbortController().signal },
        );
      }
    }
    return this.inner.append(forRun, events, expectedSeq, leaseOwner);
  }

  appendWithSnapshot(
    forRun: Id,
    events: Parameters<EventStore["appendWithSnapshot"]>[1],
    expectedSeq: number,
    snapshot: Parameters<EventStore["appendWithSnapshot"]>[3],
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    return this.inner.appendWithSnapshot(forRun, events, expectedSeq, snapshot, leaseOwner);
  }

  appendWithUsage(...args: Parameters<EventStore["appendWithUsage"]>) {
    return this.inner.appendWithUsage(...args);
  }

  readUsageLedger(...args: Parameters<EventStore["readUsageLedger"]>) {
    return this.inner.readUsageLedger(...args);
  }

  claimRunExecution(...args: Parameters<EventStore["claimRunExecution"]>) {
    return this.inner.claimRunExecution(...args);
  }

  renewRunExecution(...args: Parameters<EventStore["renewRunExecution"]>) {
    return this.inner.renewRunExecution(...args);
  }

  releaseRunExecution(...args: Parameters<EventStore["releaseRunExecution"]>) {
    return this.inner.releaseRunExecution(...args);
  }

  latestSnapshot(forRun: Id) {
    return this.inner.latestSnapshot(forRun);
  }

  retainedSnapshots(forRun: Id, limit: number) {
    return this.inner.retainedSnapshots(forRun, limit);
  }

  read(forRun: Id, range?: Parameters<EventStore["read"]>[1]) {
    return this.inner.read(forRun, range);
  }

  watch(...args: Parameters<EventStore["watch"]>) {
    return this.inner.watch(...args);
  }

  watchRuns(...args: Parameters<EventStore["watchRuns"]>) {
    return this.inner.watchRuns(...args);
  }

  head(forRun: Id) {
    return this.inner.head(forRun);
  }

  deleteRun(forRun: Id) {
    return this.inner.deleteRun(forRun);
  }

  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    return this.inner.consumeConfirmationState(stateId, expiresAt, now);
  }

  claimIdempotencyKey(
    keyHash: Parameters<EventStore["claimIdempotencyKey"]>[0],
    candidateRunId: Id,
    createdAt: number,
  ) {
    return this.inner.claimIdempotencyKey(keyHash, candidateRunId, createdAt);
  }

  takeoverIdempotencyKey(
    ...args: Parameters<EventStore["takeoverIdempotencyKey"]>
  ): ReturnType<EventStore["takeoverIdempotencyKey"]> {
    return this.inner.takeoverIdempotencyKey(...args);
  }

  releaseIdempotencyKey(
    keyHash: Parameters<EventStore["releaseIdempotencyKey"]>[0],
    claimedRunId: Id,
  ) {
    return this.inner.releaseIdempotencyKey(keyHash, claimedRunId);
  }

  listRuns(options: Parameters<EventStore["listRuns"]>[0]) {
    return this.inner.listRuns(options);
  }

  findRunsByTrace(traceId: Parameters<EventStore["findRunsByTrace"]>[0]) {
    return this.inner.findRunsByTrace(traceId);
  }

  fetchOutbox(sinkId: Code, limit: number) {
    return this.inner.fetchOutbox(sinkId, limit);
  }

  ackOutbox(sinkId: Code, cursor: number) {
    return this.inner.ackOutbox(sinkId, cursor);
  }

  claimApprovalNotification(approvalId: Id, approvalRunId: Id, claimedAt: number, leaseMs: number) {
    return this.inner.claimApprovalNotification(approvalId, approvalRunId, claimedAt, leaseMs);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    approvalRunId: Id,
    claimedAt: number,
    sentAt: number,
  ) {
    return this.inner.markApprovalNotificationSent(approvalId, approvalRunId, claimedAt, sentAt);
  }

  releaseApprovalNotification(approvalId: Id, approvalRunId: Id, claimedAt: number) {
    return this.inner.releaseApprovalNotification(approvalId, approvalRunId, claimedAt);
  }

  close() {
    return this.inner.close();
  }
}

async function runCrashMatrix(reference: Reference, brokenOrdering = false): Promise<void> {
  for (const mode of ["before_commit", "after_commit"] as const) {
    let sawResumeAmbiguity = false;
    for (let crashAt = 1; crashAt <= reference.appendCount; crashAt += 1) {
      const directory = await mkdtemp(join(tmpdir(), "harness-crash-matrix-"));
      const database = new SqliteEventStore(join(directory, "events.sqlite"));
      const scenario = createScenario();
      const delegatedStore = brokenOrdering
        ? new PreIntentExecutionStore(database, scenario.tool)
        : database;
      const store = new CrashingEventStore(delegatedStore, { crashAt, mode });
      const clock = new FakeClock(100);
      const firstRuntime = await createRuntime(config, {
        ...modelOptions(scenario, store, idsAfter(0)),
        clock,
      });
      let crashed = false;
      try {
        await firstRuntime.run(goal);
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) {
          throw error;
        }
        crashed = true;
      }
      expect(crashed, `${mode} append ${String(crashAt)} was not reached`).toBe(true);

      const initialEvents = await readEvents(store, runId);
      const inputExists = initialEvents.some((event) => event.type === "run_input");
      const freshRuntime = await createRuntime(config, {
        ...modelOptions(scenario, store, idsAfter(100)),
        clock,
      });
      try {
        if (!inputExists) {
          expect(initialEvents).toEqual([]);
          expect(scenario.counts).toEqual({ nonIdempotent: 0, idempotent: 0 });
          const result = await freshRuntime.run(goal);
          const restartedEvents = await readEvents(store, idAt(100));
          expect(result.status).toBe("completed");
          expect(semanticEvents(restartedEvents)).toEqual(reference.semantic);
          expect(scenario.counts).toEqual({ nonIdempotent: 1, idempotent: 1 });
          continue;
        }

        let resumedStatus: string;
        try {
          resumedStatus = (await freshRuntime.resume(runId)).status;
        } catch (error) {
          if (!(error instanceof RunAlreadyTerminalError)) {
            throw error;
          }
          resumedStatus = "already_terminal";
        }
        const finalEvents = await readEvents(store, runId);
        expect(hasUnrecordedProposedCall(finalEvents)).toBeUndefined();
        expect(hasUnrecordedFinalStatus(finalEvents)).toBe(false);
        expect(hasReplayedFinalResponse(finalEvents)).toBe(false);
        if (danglingIntent(finalEvents, nonIdempotentCallId)) {
          sawResumeAmbiguity = true;
          expect(resumedStatus).toBe("suspended");
          const approval = finalEvents.find((event) => event.type === "approval_requested");
          expect(approval?.type).toBe("approval_requested");
          expect(
            isResumeAmbiguityPayload(
              approval?.type === "approval_requested" ? approval.payload : undefined,
            ),
          ).toBe(true);
          const boundary = reference.boundaries[crashAt - 1];
          const crashedAfterEffect =
            mode === "before_commit" &&
            boundary?.eventTypes.includes("tool_result") === true &&
            boundary.callIds.includes(nonIdempotentCallId);
          const crashedBeforeEffect =
            (mode === "after_commit" &&
              boundary?.eventTypes.includes("tool_intent") === true &&
              boundary.callIds.includes(nonIdempotentCallId)) ||
            (boundary?.eventTypes.includes("tool_execution_started") === true &&
              boundary.callIds.includes(nonIdempotentCallId));
          expect(
            crashedAfterEffect || crashedBeforeEffect,
            `${mode} append ${String(crashAt)} (${boundary?.eventTypes.join(",") ?? "no-boundary"})`,
          ).toBe(true);
          expect(scenario.counts.nonIdempotent).toBe(crashedAfterEffect ? 1 : 0);
          continue;
        }
        expect(
          resumedStatus === "already_terminal" ? "completed" : resumedStatus,
          `${mode} append ${String(crashAt)}`,
        ).toBe("completed");
        expect(semanticEvents(finalEvents), `${mode} append ${String(crashAt)}`).toEqual(
          reference.semantic,
        );
        expect(scenario.counts.nonIdempotent).toBe(1);
        expect(scenario.counts.idempotent).toBeLessThanOrEqual(2);
      } catch (error) {
        throw new Error(
          `${mode} append ${String(crashAt)} (${reference.boundaries[crashAt - 1]?.eventTypes.join(",") ?? "no-boundary"})`,
          { cause: error },
        );
      } finally {
        await freshRuntime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(sawResumeAmbiguity).toBe(true);
  }
}

interface SubagentCrashReference {
  readonly appendCount: number;
  readonly parentRunId: Id;
  readonly childRunId: Id;
  readonly boundaries: readonly AppendBoundary[];
}

const subagentSpawnCallId = Id.parse("88888888888888888888888880");
const subagentToolCallId = Id.parse("88888888888888888888888881");
const subagentToolId = Code.parse("write_once");

function subagentCrashConfig() {
  return {
    run: RunConfigSchema.parse({
      checkpointEveryEvents: 3,
      resume: { onNonIdempotent: "escalate" },
    }),
    pii: PiiConfigSchema.parse({ enabled: false }),
    models: ModelsConfigSchema.parse({
      routing: {
        default: [{ provider: "local", model: "parent" }],
        roles: { worker: [{ provider: "local", model: "worker" }] },
      },
    }),
    roles: [
      { id: "worker", route: "worker", tools: [subagentToolId], maxDepth: 1, maxChildren: 1 },
    ],
  };
}

function subagentCrashModel(): ModelPort {
  const response = (parts: ModelCompletion["parts"]): ModelCompletion => ({
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "fake",
    model: "crash-matrix",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  });
  const resultRecorded = (request: ModelRequest, callId: Id): boolean =>
    request.messages.some((message) =>
      message.parts.some((part) => part.type === "tool_result" && part.callId === callId),
    );
  return {
    complete: (request) => {
      if (request.role === "worker") {
        return Promise.resolve(
          resultRecorded(request, subagentToolCallId)
            ? response([{ type: "text", text: "child finished" }])
            : response([
                { type: "text", text: "run the child tool" },
                {
                  type: "tool_call",
                  callId: subagentToolCallId,
                  toolId: subagentToolId,
                  args: { value: "synthetic" },
                },
              ]),
        );
      }
      return Promise.resolve(
        resultRecorded(request, subagentSpawnCallId)
          ? response([{ type: "text", text: "parent finished" }])
          : response([
              { type: "text", text: "spawn one child" },
              {
                type: "tool_call",
                callId: subagentSpawnCallId,
                toolId: Code.parse("agent.spawn"),
                args: { role: "worker", goal: "recover one child" },
              },
            ]),
      );
    },
  };
}

function createSubagentCrashRuntime(store: EventStore, recordWrite: () => void, ids: IdGenerator) {
  const tool: ToolPort = {
    describe: (toolId) =>
      toolId === subagentToolId ? { idempotent: false, timeoutMs: 1_000 } : undefined,
    getToolSpecs: () => [
      {
        toolId: subagentToolId,
        description: "Write a synthetic value once",
        inputSchema: { type: "object" },
      },
    ],
    execute: () => {
      recordWrite();
      return Promise.resolve({ outcome: "ok", result: { written: true } });
    },
  };
  return createRuntime(subagentCrashConfig(), {
    store,
    clock: new FakeClock(100),
    ids,
    model: subagentCrashModel(),
    tool,
    context: new NaiveContext(),
    policy: allowAllPolicy,
    transientVault: true,
  });
}

async function discoverSubagentReference(directory: string): Promise<SubagentCrashReference> {
  const database = new SqliteEventStore(join(directory, "subagent-reference.sqlite"));
  const boundaries = new BoundaryRecordingStore(database);
  const counts = { writes: 0 };
  const store = new CrashingEventStore(boundaries, {
    crashAt: Number.MAX_SAFE_INTEGER,
    mode: "before_commit",
  });
  const runtime = await createSubagentCrashRuntime(
    store,
    () => {
      counts.writes += 1;
    },
    idsAfter(0),
  );
  try {
    const result = await runtime.run("subagent crash matrix");
    const parentRunId = result.events[0]?.runId;
    if (parentRunId === undefined) {
      throw new Error("Expected the reference parent run.");
    }
    const parentEvents = await readEvents(store, parentRunId);
    const spawned = parentEvents.find((event) => event.type === "subagent_spawned");
    if (spawned?.type !== "subagent_spawned") {
      throw new Error("Expected the reference child announcement.");
    }
    const childEvents = await readEvents(store, spawned.childRunId);
    expect(counts.writes).toBe(1);
    expect(childEvents.some((event) => event.type === "tool_result")).toBe(true);
    return {
      appendCount: boundaries.boundaries.length,
      parentRunId,
      childRunId: spawned.childRunId,
      boundaries: boundaries.boundaries,
    };
  } finally {
    await runtime.close();
  }
}

async function runSubagentCrashMatrix(reference: SubagentCrashReference): Promise<void> {
  for (const mode of ["before_commit", "after_commit"] as const) {
    for (let crashAt = 1; crashAt <= reference.appendCount; crashAt += 1) {
      const directory = await mkdtemp(join(tmpdir(), "harness-subagent-crash-"));
      const filename = join(directory, "events.sqlite");
      const firstDatabase = new SqliteEventStore(filename);
      const initialBoundaries = new BoundaryRecordingStore(firstDatabase);
      const counts = { writes: 0 };
      const crashingStore = new CrashingEventStore(initialBoundaries, {
        crashAt,
        mode,
        persistentCrash: true,
      });
      const firstRuntime = await createSubagentCrashRuntime(
        crashingStore,
        () => {
          counts.writes += 1;
        },
        idsAfter(0),
      );
      let crashed = false;
      let initialEvents: Event[] = [];
      try {
        await firstRuntime.run("subagent crash matrix");
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) {
          throw error;
        }
        crashed = true;
      }
      initialEvents = await readEvents(crashingStore, reference.parentRunId);
      await firstRuntime.close();
      expect(crashed, `${mode} append ${String(crashAt)} was not reached`).toBe(true);

      const restartDatabase = new SqliteEventStore(filename);
      const restartBoundaries = new BoundaryRecordingStore(restartDatabase);
      const restartStore = new CrashingEventStore(restartBoundaries, {
        crashAt: Number.MAX_SAFE_INTEGER,
        mode: "before_commit",
      });
      const freshRuntime = await createSubagentCrashRuntime(
        restartStore,
        () => {
          counts.writes += 1;
        },
        idsAfter(100),
      );
      let parentRunId = reference.parentRunId;
      try {
        const inputExists = initialEvents.some((event) => event.type === "run_input");
        if (!inputExists) {
          await freshRuntime.run("subagent crash matrix");
          parentRunId = idAt(100);
        } else {
          try {
            await freshRuntime.resume(parentRunId);
          } catch (error) {
            if (!(error instanceof RunAlreadyTerminalError)) {
              throw error;
            }
          }
        }

        let parentEvents = await readEvents(restartStore, parentRunId);
        const spawn = parentEvents.find(
          (event) =>
            event.type === "subagent_spawned" && event.parentCallId === subagentSpawnCallId,
        );
        if (spawn?.type !== "subagent_spawned") {
          throw new Error("Expected the recovered parent to announce its child.");
        }
        let childEvents = await readEvents(restartStore, spawn.childRunId);
        const parentStatus = parentEvents.findLast((event) => event.type === "run_status_changed");
        if (parentStatus?.type === "run_status_changed" && parentStatus.to === "suspended") {
          const approval = childEvents.find(
            (event) =>
              event.type === "approval_requested" &&
              event.callId === subagentToolCallId &&
              !childEvents.some(
                (candidate) =>
                  candidate.type === "approval_resolved" &&
                  candidate.approvalId === event.approvalId,
              ),
          );
          if (approval?.type !== "approval_requested") {
            throw new Error("Expected child approval before resuming the parent.");
          }
          await freshRuntime.resolveApproval(spawn.childRunId, approval.approvalId, "approve", {
            metadata: { decidedBy: "human", approverId: "cli.test" },
          });
          try {
            await freshRuntime.resume(parentRunId);
          } catch (error) {
            if (!(error instanceof RunAlreadyTerminalError)) {
              throw error;
            }
          }
        }
        parentEvents = await readEvents(restartStore, parentRunId);
        childEvents = await readEvents(restartStore, spawn.childRunId);
        const finalStatus = parentEvents.findLast((event) => event.type === "run_status_changed");
        expect(finalStatus).toMatchObject({ type: "run_status_changed", to: "completed" });
        const announcedChildren = parentEvents.filter(
          (event) =>
            event.type === "subagent_spawned" && event.parentCallId === subagentSpawnCallId,
        );
        expect(announcedChildren).toHaveLength(1);
        expect(
          parentEvents.filter(
            (event) => event.type === "subagent_completed" && event.childRunId === spawn.childRunId,
          ),
        ).toHaveLength(1);
        expect(
          parentEvents.filter(
            (event) => event.type === "tool_result" && event.callId === subagentSpawnCallId,
          ),
        ).toHaveLength(1);
        expect(childEvents.filter((event) => event.type === "run_created")).toHaveLength(
          childEvents.length === 0 ? 0 : 1,
        );
        const childRan = childEvents.some(
          (event) => event.type === "model_request" || event.type === "tool_intent",
        );
        const crashAfterExecutionClaim =
          mode === "after_commit" &&
          reference.boundaries[crashAt - 1]?.eventTypes.includes("tool_execution_started") === true;
        expect(
          counts.writes,
          `${mode} append ${String(crashAt)} (${reference.boundaries[crashAt - 1]?.eventTypes.join(",") ?? "no-boundary"})`,
        ).toBe(childRan && !crashAfterExecutionClaim ? 1 : 0);
        if (childRan) {
          expect(
            childEvents.filter(
              (event) => event.type === "tool_intent" && event.callId === subagentToolCallId,
            ),
          ).toHaveLength(1);
          expect(
            childEvents.filter(
              (event) =>
                event.type === "tool_execution_started" && event.callId === subagentToolCallId,
            ),
          ).toHaveLength(1);
          expect(
            childEvents.filter(
              (event) => event.type === "tool_result" && event.callId === subagentToolCallId,
            ),
          ).toHaveLength(1);
          if (
            mode === "before_commit" &&
            reference.boundaries[crashAt - 1]?.eventTypes.includes("tool_result") === true &&
            reference.boundaries[crashAt - 1]?.callIds.includes(subagentToolCallId) === true
          ) {
            expect(
              childEvents.filter(
                (event) => event.type === "tool_result" && event.callId === subagentToolCallId,
              ),
            ).toMatchObject([{ outcome: "error", errorCode: "resume_ambiguous" }]);
          }
        }
      } catch (error) {
        throw new Error(
          `${mode} append ${String(crashAt)} child (${reference.boundaries[crashAt - 1]?.eventTypes.join(",") ?? "no-boundary"})`,
          { cause: error },
        );
      } finally {
        await freshRuntime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

describe("SQLite crash-injection matrix", () => {
  it("recovers between an unstructured final response and its structured call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-structured-final-crash-"));
    const structuredRunId = Id.parse("00000000000000000000000020");
    const segmentId = Id.parse("11111111111111111111111120");
    const clock = new FakeClock(100);
    const database = new SqliteEventStore(join(directory, "events.sqlite"));
    const store = new CrashingEventStore(database, { crashAt: 3, mode: "after_commit" });
    const tracingRuntime = await createRuntime(config, { dataDir: join(directory, "tracing") });
    await tracingRuntime.close();
    ensureTracingFallback(
      RUN_SPAN.start({
        "harness.run.id": structuredRunId,
        "harness.segment.id": segmentId,
      }),
    );
    const schema = z.object({ answer: z.string() }).strict();
    let structuredCalls = 0;
    const model: ModelPort = {
      complete: (_request, context) => {
        if (context.outputSchema !== undefined) {
          structuredCalls += 1;
          return Promise.resolve({
            parts: [{ type: "text", text: '{"answer":"recovered"}' }],
            usage: { inputTokens: 2, outputTokens: 1 },
            finishReason: "stop",
            provider: "fake",
            model: "structured",
            latencyMs: 1,
            schemaValid: true,
            repairAttempts: 0,
            rungUsed: "native",
            fallbackDepth: 0,
            providerBlobs: null,
          });
        }
        return Promise.resolve({
          parts: [{ type: "text", text: "unstructured final candidate" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: "fake",
          model: "plain",
          latencyMs: 1,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        });
      },
    };
    const tool = new FakeToolPort();
    const context = new NaiveContext();
    const budgets = config.run.budgets;
    const structuredGoal = "recover structured final";
    try {
      await expect(
        runLoop({
          recorder: new RunRecorder(store, structuredRunId, segmentId, 0, clock),
          clock,
          model,
          tool,
          context,
          ids: idsAfter(0),
          goal: structuredGoal,
          configHash: "a".repeat(64),
          budgets,
          policyVersion: "test.policy",
          signal: new AbortController().signal,
          finalOutputSchema: schema,
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(
        (await readEvents(store, structuredRunId)).filter(
          (event) => event.type === "model_response",
        ),
      ).toHaveLength(1);

      const resumed = await resumeRun({
        store,
        runId: structuredRunId,
        clock,
        model,
        tool,
        context,
        ids: idsAfter(100),
        goal: structuredGoal,
        budgets,
        signal: new AbortController().signal,
        finalOutputSchema: schema,
      });
      const events = await readEvents(store, structuredRunId);

      expect(resumed.status).toBe("completed");
      expect(structuredCalls).toBe(1);
      expect(events.filter((event) => event.type === "model_response")).toHaveLength(2);
      const completedRuns = events.filter(
        (event) => event.type === "run_status_changed" && event.to === "completed",
      );
      expect(completedRuns).toHaveLength(1);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["ask", "deny"] as const)(
    "recovers an idempotent %s decision after its atomic intent append",
    async (decision) => {
      const directory = await mkdtemp(join(tmpdir(), `harness-${decision}-crash-`));
      const clock = new FakeClock(100);
      const callId = Id.parse("66666666666666666666666666");
      const policy: PolicyPort = {
        version: Code.parse("test.policy"),
        decide: () => ({
          decision,
          ruleId: decision === "ask" ? "review_rule" : "deny_rule",
          reason: decision === "ask" ? "human_review" : "policy_forbidden",
          editable: [],
        }),
      };
      const completionFor = (parts: ModelCompletion["parts"]): ModelCompletion => ({
        parts,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        provider: "fake",
        model: "script",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
      const createModel = () =>
        new FakeModelPort([
          completionFor([
            {
              type: "tool_call",
              callId,
              toolId: "reviewed_tool",
              args: { path: "synthetic" },
            },
          ]),
          completionFor([{ type: "text", text: "finished" }]),
        ]);
      const execute = vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null }));
      const tool = new FakeToolPort(
        new Map([["reviewed_tool", { idempotent: true, timeoutMs: 1_000, execute }]]),
      );
      const createTestRuntime = (store: EventStore) =>
        createRuntime(config, {
          store,
          clock,
          ids: idsAfter(0),
          model: createModel(),
          tool,
          context: new NaiveContext(),
          policy,
        });

      const referenceStore = new BoundaryRecordingStore(
        new SqliteEventStore(join(directory, "reference.sqlite")),
      );
      const referenceRuntime = await createTestRuntime(referenceStore);
      let crashAt: number;
      try {
        const reference = await referenceRuntime.run(goal);
        expect(reference.status).toBe(decision === "ask" ? "suspended" : "completed");
        crashAt =
          referenceStore.boundaries.findIndex(
            ({ eventTypes, callIds }) =>
              callIds.includes(callId) && eventTypes.includes("tool_intent"),
          ) + 1;
      } finally {
        await referenceRuntime.close();
      }
      expect(crashAt).toBeGreaterThan(0);

      const crashBoundaries = new BoundaryRecordingStore(
        new SqliteEventStore(join(directory, "events.sqlite")),
      );
      const store = new CrashingEventStore(crashBoundaries, {
        crashAt,
        mode: "after_commit",
      });
      const runtime = await createTestRuntime(store);
      try {
        await expect(runtime.run(goal)).rejects.toBeInstanceOf(SimulatedCrash);
        const initialEvents = await readEvents(store, runId);
        const intent = initialEvents.find(
          (event) => event.type === "tool_intent" && event.callId === callId,
        );
        const result = initialEvents.find(
          (event) => event.type === "tool_result" && event.callId === callId,
        );
        const request = initialEvents.find(
          (event) => event.type === "approval_requested" && event.callId === callId,
        );
        const crashedBoundary = crashBoundaries.boundaries[crashAt - 1];

        let blockedResumeError: unknown;
        let callsBeforeApproval = 0;
        let resumedStatus: string | undefined;
        if (decision === "ask") {
          if (request?.type !== "approval_requested") {
            throw new Error("Expected the durable policy approval request.");
          }
          try {
            await runtime.resume(runId);
          } catch (error) {
            blockedResumeError = error;
          }
          callsBeforeApproval = execute.mock.calls.length;
          await resolveApproval(
            store,
            runId,
            request.approvalId,
            "approve",
            undefined,
            clock,
            undefined,
            { decidedBy: "human", approverId: "cli.test" },
          );
          resumedStatus = (await runtime.resume(runId)).status;
        } else {
          callsBeforeApproval = execute.mock.calls.length;
          resumedStatus = (await runtime.resume(runId)).status;
        }
        const deniedOrApproval = decision === "ask" ? request : result;
        const finalEvents = await readEvents(store, runId);
        const blockedResumeCode =
          typeof blockedResumeError === "object" &&
          blockedResumeError !== null &&
          "code" in blockedResumeError
            ? blockedResumeError.code
            : undefined;

        expect(crashedBoundary?.eventTypes).toContain("tool_intent");
        expect(crashedBoundary?.eventTypes).toContain(
          decision === "ask" ? "approval_requested" : "tool_result",
        );
        expect(intent).toMatchObject({
          policyDecision: decision,
          ruleId: decision === "ask" ? "review_rule" : "deny_rule",
          policyReason: decision === "ask" ? "human_review" : "policy_forbidden",
        });
        expect(deniedOrApproval).toMatchObject(
          decision === "ask"
            ? { type: "approval_requested", payload: { kind: "tool_call" } }
            : { type: "tool_result", outcome: "denied", errorCode: "policy_forbidden" },
        );
        expect(blockedResumeCode).toBe(decision === "ask" ? "run_awaiting_approval" : undefined);
        expect(callsBeforeApproval).toBe(0);
        expect(resumedStatus).toBe("completed");
        expect(execute).toHaveBeenCalledTimes(decision === "ask" ? 1 : 0);
        expect(finalEvents.filter((event) => event.type === "tool_intent")).toHaveLength(1);
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("resumes each append boundary in both modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-crash-reference-"));
    try {
      const reference = await discoverReference(directory);
      expect(reference.appendCount).toBeGreaterThan(0);
      await runCrashMatrix(reference);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("resumes children across every append boundary in both logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-subagent-crash-reference-"));
    try {
      const reference = await discoverSubagentReference(directory);
      expect(
        reference.boundaries.some(
          ({ runId: boundaryRunId }) => boundaryRunId === reference.parentRunId,
        ),
      ).toBe(true);
      expect(
        reference.boundaries.some(
          ({ runId: boundaryRunId }) => boundaryRunId === reference.childRunId,
        ),
      ).toBe(true);
      expect(reference.appendCount).toBeGreaterThan(0);
      await runSubagentCrashMatrix(reference);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails the crash matrix when a broken store executes tools before intent durability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-crash-negative-"));
    try {
      const reference = await discoverReference(directory);
      await expect(runCrashMatrix(reference, true)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("SQLite compaction crash recovery", () => {
  it.each(["before_commit", "after_commit"] as const)(
    "resumes a compaction append failure %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "harness-compaction-crash-"));
      const compactRunId = Id.parse("00000000000000000000000001");
      const segmentId = Id.parse("11111111111111111111111111");
      const compactGoal = "compaction crash recovery";
      const clock = new FakeClock(100);
      const ids = new SequentialIdGenerator();
      const database = new SqliteEventStore(join(directory, "events.sqlite"));
      const store = new CrashingEventStore(database, { crashAt: 6, mode });
      const tracingRuntime = await createRuntime(config, { dataDir: join(directory, "tracing") });
      await tracingRuntime.close();
      const model = new FakeModelPort([
        {
          parts: [
            { type: "text", text: "calling lookup" },
            {
              type: "tool_call",
              callId: Id.parse("22222222222222222222222222"),
              toolId: "lookup",
              args: { query: "synthetic" },
            },
          ],
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: "stop",
          provider: "fake",
          model: "script",
          latencyMs: 1,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        },
        {
          parts: [{ type: "text", text: "finished" }],
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: "stop",
          provider: "fake",
          model: "script",
          latencyMs: 1,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        },
      ]);
      const tool = new FakeToolPort(
        new Map([
          [
            "lookup",
            {
              idempotent: true,
              timeoutMs: 1_000,
              execute: () => Promise.resolve({ outcome: "ok", result: { found: true } }),
            },
          ],
        ]),
      );
      const context = new NaiveContext();
      const summarize = vi.fn(() =>
        Promise.resolve({
          text: "durable summary",
          usage: { inputTokens: 4, outputTokens: 2, costMicros: 3 },
        }),
      );
      const compaction = {
        strategy: new SummarizingStrategy({ provider: "fake", model: "script" }),
        summarizer: { summarize },
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text: string) => Promise.resolve(text),
        keepRecentGroups: 0,
      };
      const budgets = {
        maxSteps: 10,
        maxWallClockMs: 60_000,
        countSuspendedTime: false,
      };
      try {
        await expect(
          runLoop({
            recorder: new RunRecorder(store, compactRunId, segmentId, 0, clock),
            clock,
            model,
            tool,
            context,
            ids,
            goal: compactGoal,
            configHash: "a".repeat(64),
            budgets,
            checkpointEveryEvents: 1_000,
            policyVersion: "test.policy",
            policy: allowAllPolicy,
            signal: new AbortController().signal,
            compaction,
          }),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        expect(summarize).toHaveBeenCalledOnce();
        const interruptedEvents = await readEvents(store, compactRunId);
        expect(
          interruptedEvents.filter((event) => event.type === "context_compacted"),
        ).toHaveLength(mode === "before_commit" ? 0 : 1);

        const resumed = await resumeRun({
          store,
          runId: compactRunId,
          clock,
          model,
          tool,
          context,
          ids,
          goal: compactGoal,
          budgets,
          checkpointEveryEvents: 1_000,
          policy: allowAllPolicy,
          signal: new AbortController().signal,
          compaction,
        });
        const events = await readEvents(store, compactRunId);

        expect(resumed.status).toBe("completed");
        expect(events.filter((event) => event.type === "context_compacted")).toHaveLength(1);
        expect(events.filter((event) => event.type === "model_response")).toHaveLength(2);
        expect(resumed.state.usage).toEqual({ inputTokens: 8, outputTokens: 4, costMicros: 3 });
        expect(summarize).toHaveBeenCalledTimes(mode === "before_commit" ? 2 : 1);
      } finally {
        await database.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
