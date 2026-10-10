// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type JsonValue,
  type NewEvent,
} from "@harness/schemas";
import {
  createRuntime,
  RunAlreadyTerminalError,
  type ContextPort,
  type IdGenerator,
  type ModelCompletion,
  type ModelRequest,
} from "@harness/core";
import {
  CrashingEventStore,
  FakeModelPort,
  FakeToolPort,
  SimulatedCrash,
  type FakeModelOptions,
  type FakeToolDefinition,
} from "@harness/core/testing";
import { SqliteEventStore, type EventStore } from "@harness/store";
import { describe, expect, it } from "vitest";

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
  readonly method: "append" | "appendWithSnapshot";
  readonly eventTypes: readonly Event["type"][];
  readonly callIds: readonly Id[];
}

type SemanticEvent =
  | { readonly type: "model_response"; readonly content: JsonValue }
  | {
      readonly type: "tool_result";
      readonly toolId: string;
      readonly outcome: string;
      readonly result: JsonValue;
      readonly errorCode?: string;
    };

const scriptedCalls = new Map<JsonValue, Id>([
  ["non-idempotent request", nonIdempotentCallId],
  ["idempotent request", idempotentCallId],
]);

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
  if (
    typeof request.messages !== "object" ||
    request.messages === null ||
    Array.isArray(request.messages)
  ) {
    return 0;
  }
  const context = request.messages.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return 0;
  }
  const position = context.position;
  return typeof position === "number" && Number.isSafeInteger(position) ? position : 0;
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
    content: JsonValue,
    toolCalls: ModelCompletion["toolCalls"] = [],
  ): ModelCompletion => ({
    content,
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    provider: "fake",
    model: "script",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
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
    build: (events) =>
      Promise.resolve({
        position: events.filter((event) => event.type === "model_response").length,
      }),
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
  ): Promise<{ nextSeq: number }> {
    this.boundaries.push({
      method: "append",
      eventTypes: events.map(({ type }) => type),
      callIds: events.flatMap((event) =>
        event.type === "tool_intent" || event.type === "tool_result" ? [event.callId] : [],
      ),
    });
    return this.inner.append(forRun, events, expectedSeq);
  }

  appendWithSnapshot(
    forRun: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Parameters<EventStore["appendWithSnapshot"]>[3],
  ): Promise<{ nextSeq: number }> {
    this.boundaries.push({
      method: "appendWithSnapshot",
      eventTypes: events.map(({ type }) => type),
      callIds: events.flatMap((event) =>
        event.type === "tool_intent" || event.type === "tool_result" ? [event.callId] : [],
      ),
    });
    return this.inner.appendWithSnapshot(forRun, events, expectedSeq, snapshot);
  }

  latestSnapshot(forRun: Id) {
    return this.inner.latestSnapshot(forRun);
  }

  read(forRun: Id, range?: Parameters<EventStore["read"]>[1]) {
    return this.inner.read(forRun, range);
  }

  head(forRun: Id) {
    return this.inner.head(forRun);
  }

  listRuns(options: Parameters<EventStore["listRuns"]>[0]) {
    return this.inner.listRuns(options);
  }

  findRunsByTrace(traceId: Parameters<EventStore["findRunsByTrace"]>[0]) {
    return this.inner.findRunsByTrace(traceId);
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
    const expectedCallId = scriptedCalls.get(event.content);
    if (
      expectedCallId !== undefined &&
      !events.some(
        (candidate) => candidate.type === "tool_intent" && candidate.callId === expectedCallId,
      )
    ) {
      return expectedCallId;
    }
  }
  return undefined;
}

function hasUnrecordedFinalStatus(events: readonly Event[]): boolean {
  const finalAnswerRecorded = events.some(
    (event) => event.type === "model_response" && event.content === "final answer",
  );
  const completed = events.some(
    (event) => event.type === "run_status_changed" && event.to === "completed",
  );
  return finalAnswerRecorded && !completed;
}

function hasReplayedFinalResponse(events: readonly Event[]): boolean {
  return (
    events.filter((event) => event.type === "model_response" && event.content === "final answer")
      .length > 1
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
  ): Promise<{ nextSeq: number }> {
    for (const event of events) {
      if (event.type === "tool_intent") {
        await this.tool.execute(
          { callId: event.callId, toolId: event.toolId, args: event.args },
          { runId: forRun, signal: new AbortController().signal },
        );
      }
    }
    return this.inner.append(forRun, events, expectedSeq);
  }

  appendWithSnapshot(
    forRun: Id,
    events: Parameters<EventStore["appendWithSnapshot"]>[1],
    expectedSeq: number,
    snapshot: Parameters<EventStore["appendWithSnapshot"]>[3],
  ): Promise<{ nextSeq: number }> {
    return this.inner.appendWithSnapshot(forRun, events, expectedSeq, snapshot);
  }

  latestSnapshot(forRun: Id) {
    return this.inner.latestSnapshot(forRun);
  }

  read(forRun: Id, range?: Parameters<EventStore["read"]>[1]) {
    return this.inner.read(forRun, range);
  }

  head(forRun: Id) {
    return this.inner.head(forRun);
  }

  listRuns(options: Parameters<EventStore["listRuns"]>[0]) {
    return this.inner.listRuns(options);
  }

  findRunsByTrace(traceId: Parameters<EventStore["findRunsByTrace"]>[0]) {
    return this.inner.findRunsByTrace(traceId);
  }

  close() {
    return this.inner.close();
  }
}

async function runCrashMatrix(reference: Reference, brokenOrdering = false): Promise<void> {
  let sawResumeAmbiguity = false;
  for (const mode of ["before_commit", "after_commit"] as const) {
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
      const inputExists = initialEvents.some((event) => event.type === "model_request");
      const freshRuntime = await createRuntime(config, {
        ...modelOptions(scenario, store, idsAfter(100)),
        clock,
      });
      try {
        if (!inputExists) {
          // TODO(15.1): these points can resume directly once run_input is durable.
          await expect(freshRuntime.resume(runId)).rejects.toMatchObject({
            code: "run_input_missing",
          });
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
        const missingCallId = hasUnrecordedProposedCall(finalEvents);
        if (missingCallId !== undefined) {
          // TODO(2.11): model_response does not persist toolCalls; resume cannot recover a proposal
          // after its response is committed but before the corresponding tool_intent is durable.
          expect(semanticEvents(finalEvents)).not.toEqual(reference.semantic);
          if (missingCallId === nonIdempotentCallId) {
            expect(scenario.counts.nonIdempotent).toBe(0);
          } else {
            expect(scenario.counts.idempotent).toBe(0);
          }
          continue;
        }
        if (hasUnrecordedFinalStatus(finalEvents) || hasReplayedFinalResponse(finalEvents)) {
          // TODO(2.11): a final model_response is not itself a durable completion decision.
          expect(semanticEvents(finalEvents)).not.toEqual(reference.semantic);
          expect(["completed", "failed"]).toContain(resumedStatus);
          expect(scenario.counts).toEqual({ nonIdempotent: 1, idempotent: 1 });
          continue;
        }
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
          const executions = scenario.counts.nonIdempotent;
          expect([0, 1]).toContain(executions);
          const boundary = reference.boundaries[crashAt - 1];
          if (
            mode === "before_commit" &&
            boundary?.eventTypes.includes("tool_result") === true &&
            boundary.callIds.includes(nonIdempotentCallId)
          ) {
            expect(executions).toBe(1);
          }
          if (
            mode === "after_commit" &&
            boundary?.eventTypes.includes("tool_intent") === true &&
            boundary.callIds.includes(nonIdempotentCallId)
          ) {
            expect(executions).toBe(0);
          }
          if (executions > 0) {
            expect(executions).toBe(1);
          }
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
      } finally {
        await freshRuntime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(sawResumeAmbiguity).toBe(true);
  }
}

describe("SQLite crash-injection matrix", () => {
  it("resumes each append boundary in both modes and documents the model-tool durability gap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-crash-reference-"));
    try {
      const reference = await discoverReference(directory);
      expect(reference.appendCount).toBeGreaterThan(0);
      await runCrashMatrix(reference);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
