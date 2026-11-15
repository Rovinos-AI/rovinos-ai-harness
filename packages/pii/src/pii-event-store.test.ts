// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  Id,
  PiiConfigSchema,
  SequentialIdGenerator,
  Code,
  type Detection,
  type Event,
  type JsonValue,
  type NewEvent,
  type SpendReservation,
  type SpendReservationInput,
  type SpendReservationSettlement,
  type Snapshot,
} from "@rovinos/schemas";
import {
  AuditingVaultResolver,
  InMemoryVault,
  type VaultAudit,
  type VaultWriter,
} from "@rovinos/vault";
import { emailDetector } from "./detectors/email.js";
import {
  PiiEventStore,
  markSanitized,
  markSanitizedField,
  type EventStoreLike,
} from "./pii-event-store.js";
import { PiiStorageFailedError } from "./errors.js";
import { Tokenizer, type PiiDetectorRegistry } from "./tokenizer.js";
import { PiiToolPort, type PiiToolContext, type PiiToolPortLike } from "./pii-tool-port.js";

const ids = new SequentialIdGenerator();
const canarySeed = randomUUID();
const runId = Id.parse(ids.next());
const snapshotId = Id.parse(ids.next());
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

function canary(prefix = "storage"): string {
  return `${prefix}-${canarySeed.replaceAll("-", "").slice(0, 16)}-${ids.next().slice(-8)}@example.test`;
}

function common() {
  return { runId, ts: 10, v: 1 as const, traceId, spanId, segmentId: runId };
}

function runCreated(): NewEvent {
  return {
    ...common(),
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "policy.v1",
    depth: 0,
  };
}

function runInput(input: JsonValue): NewEvent {
  return { ...common(), type: "run_input", input, inputKind: "initial" };
}

function checkpointWritten(): NewEvent {
  return {
    ...common(),
    type: "checkpoint_written",
    checkpointId: snapshotId,
    atSeq: 1,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function spendInput(attemptId: Id): SpendReservationInput {
  return {
    runId,
    attemptId,
    quotaPeriods: [
      { quotaId: Code.parse("team"), period: "day", periodStart: 0, limitMicros: 1_000 },
    ],
    estimatedMicros: 100,
    pricingRevision: Code.parse("prices.v1"),
  };
}

function spendRequest(attemptId: Id, message: string): NewEvent {
  return {
    ...common(),
    type: "model_request",
    v: 3,
    requestId: attemptId,
    provider: "sample",
    model: "model-a",
    messages: [{ role: "user", parts: [{ type: "text", text: message }] }],
    advertisedToolIds: [],
    requestHash: "a".repeat(64),
    requestParametersHash: "b".repeat(64),
  };
}

function spendResponse(attemptId: Id, message: string): NewEvent {
  return {
    ...common(),
    type: "model_response",
    v: 2,
    requestId: attemptId,
    provider: "sample",
    model: "model-a",
    inputTokens: 2,
    outputTokens: 3,
    cost: { version: 1, state: "known", amountMicros: 5 },
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: message }],
    providerBlobs: null,
  };
}

function snapshot(context = canary("context"), plan = canary("plan")): Snapshot {
  return {
    snapshotId,
    runId,
    v: 1,
    atSeq: 1,
    createdAt: 10,
    traceparent: `00-${traceId}-${spanId}-01`,
    context: { text: context },
    plan: { text: plan },
  };
}

function createTokenizer(
  detect: PiiDetectorRegistry["detect"] = (text) => emailDetector.detect(text),
  vault: VaultWriter = new InMemoryVault(),
) {
  return new Tokenizer({
    detectors: { detect },
    policy: PiiConfigSchema.parse({}),
    vault,
  });
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

type UsageLedgerRowLike = Awaited<ReturnType<EventStoreLike["readUsageLedger"]>>[number];

function createInnerStore(): EventStoreLike {
  let events: Event[] = [];
  let savedSnapshot: Snapshot | undefined;
  let executionOwner: Id | undefined;
  const usageLedger = new Map<string, UsageLedgerRowLike>();
  return {
    append(appendRunId, newEvents, expectedSeq, _leaseOwner) {
      if (appendRunId !== runId || expectedSeq !== events.length || newEvents.length === 0) {
        throw new Error("Unexpected test-store append.");
      }
      events = [
        ...events,
        ...newEvents.map((event, index) =>
          EventSchema.parse({ ...event, seq: expectedSeq + index }),
        ),
      ];
      return Promise.resolve({ nextSeq: events.length });
    },
    async appendWithSnapshot(appendRunId, newEvents, expectedSeq, nextSnapshot, _leaseOwner) {
      const result = await this.append(appendRunId, newEvents, expectedSeq);
      savedSnapshot = nextSnapshot;
      return result;
    },
    async appendWithUsage(appendRunId, newEvents, expectedSeq, { usageUpdates }) {
      const result = await this.append(appendRunId, newEvents, expectedSeq);
      for (const delta of usageUpdates) {
        const key = `${delta.quotaId}:${delta.period}:${String(delta.periodStart)}`;
        const previous = usageLedger.get(key) ?? {
          quotaId: delta.quotaId,
          period: delta.period,
          periodStart: delta.periodStart,
          costMicros: 0,
          unknownCostCount: 0,
          runsStarted: 0,
        };
        usageLedger.set(key, {
          ...previous,
          costMicros: previous.costMicros + delta.costMicros,
          unknownCostCount: previous.unknownCostCount + (delta.unknownCostCount ?? 0),
          runsStarted: previous.runsStarted + delta.runsStarted,
        });
      }
      return result;
    },
    readUsageLedger(quotaId, period, periodStarts) {
      return Promise.resolve(
        periodStarts.flatMap((periodStart) => {
          const row = usageLedger.get(`${quotaId}:${period}:${String(periodStart)}`);
          return row === undefined ? [] : [row];
        }),
      );
    },
    claimRunExecution(_runId, owner) {
      if (executionOwner !== undefined) {
        return Promise.resolve(false);
      }
      executionOwner = owner;
      return Promise.resolve(true);
    },
    renewRunExecution(_runId, owner) {
      return Promise.resolve(executionOwner === owner);
    },
    releaseRunExecution(_runId, owner) {
      if (executionOwner === owner) {
        executionOwner = undefined;
      }
      return Promise.resolve();
    },
    latestSnapshot() {
      return Promise.resolve(savedSnapshot);
    },
    retainedSnapshots(_readRunId, limit) {
      return Promise.resolve(savedSnapshot === undefined || limit < 1 ? [] : [savedSnapshot]);
    },
    read(_readRunId, range) {
      return (async function* () {
        await Promise.resolve();
        for (const event of events) {
          if (
            (range?.fromSeq === undefined || event.seq >= range.fromSeq) &&
            (range?.toSeq === undefined || event.seq <= range.toSeq)
          ) {
            yield event;
          }
        }
      })();
    },
    head() {
      return Promise.resolve(events.length);
    },
    watch() {
      return (async function* () {
        await Promise.resolve();
      })();
    },
    watchRuns() {
      return (async function* () {
        await Promise.resolve();
      })();
    },
    deleteRun() {
      const count = events.length;
      events = [];
      savedSnapshot = undefined;
      return Promise.resolve(count);
    },
    consumeConfirmationState() {
      return Promise.resolve(false);
    },
    claimIdempotencyKey(_keyHash, candidateRunId) {
      return Promise.resolve(candidateRunId);
    },
    takeoverIdempotencyKey() {
      return Promise.resolve(false);
    },
    releaseIdempotencyKey() {
      return Promise.resolve();
    },
    listRuns() {
      return Promise.resolve({ runs: [] });
    },
    findRunsByTrace() {
      return Promise.resolve([]);
    },
    fetchOutbox() {
      return Promise.resolve({ events: [], cursor: 0 });
    },
    ackOutbox() {
      return Promise.resolve();
    },
    claimApprovalNotification() {
      return Promise.resolve(false);
    },
    markApprovalNotificationSent() {
      return Promise.resolve(false);
    },
    releaseApprovalNotification() {
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

function createReservationInnerStore(): EventStoreLike {
  const base = createInnerStore();
  const reservations = new Map<Id, SpendReservation>();
  const requireReservation = (attemptId: Id): SpendReservation => {
    const reservation = reservations.get(attemptId);
    if (reservation === undefined) {
      throw new Error("Missing test reservation.");
    }
    return reservation;
  };
  return {
    ...base,
    async reserveSpend(input, modelRequest, expectedSeq) {
      const { nextSeq } = await base.append(input.runId, [modelRequest], expectedSeq);
      const reservation: SpendReservation = {
        ...input,
        state: "reserved",
        reservedAt: 10,
      };
      reservations.set(input.attemptId, reservation);
      return { reservation, nextSeq };
    },
    markSpendDispatching(attemptId) {
      const reservation = {
        ...requireReservation(attemptId),
        state: "dispatching" as const,
      };
      reservations.set(attemptId, reservation);
      return Promise.resolve(reservation);
    },
    releaseSpend(attemptId) {
      const reservation = {
        ...requireReservation(attemptId),
        state: "released" as const,
      };
      reservations.set(attemptId, reservation);
      return Promise.resolve(reservation);
    },
    async settleSpend(settlement, modelResponse, expectedSeq, options) {
      const { nextSeq } = await base.appendWithUsage(
        settlement.runId,
        [modelResponse],
        expectedSeq,
        options,
      );
      const reservation = {
        ...requireReservation(settlement.attemptId),
        state: "settled" as const,
        settlement,
      };
      reservations.set(settlement.attemptId, reservation);
      return { reservation, nextSeq };
    },
    markSpendUncertain(attemptId, reason) {
      const reservation = {
        ...requireReservation(attemptId),
        state: "uncertain" as const,
        uncertaintyCode: reason,
      };
      reservations.set(attemptId, reservation);
      return Promise.resolve(reservation);
    },
  };
}

describe("PiiEventStore", () => {
  it("sanitizes requests and responses around transactional spend reservations", async () => {
    const inner = createReservationInnerStore();
    const store = new PiiEventStore(inner, createTokenizer());
    const attemptId = Id.parse(ids.next());
    const requestCanary = canary("reserved-request");
    const responseCanary = canary("settled-response");

    await store.append(runId, [runCreated()], 0);
    await store.reserveSpend(spendInput(attemptId), spendRequest(attemptId, requestCanary), 1);
    await store.markSpendDispatching(attemptId);
    const settlement: SpendReservationSettlement = {
      runId,
      attemptId,
      cost: { version: 1, state: "known", amountMicros: 5 },
      responseHash: "c".repeat(64),
    };
    await store.settleSpend(settlement, spendResponse(attemptId, responseCanary), 2, {
      usageUpdates: [
        {
          quotaId: Code.parse("team"),
          period: "day",
          periodStart: 0,
          costMicros: 5,
          runsStarted: 0,
        },
      ],
    });

    const events = await collect(store.read(runId));
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      type: "model_request",
      messages: [{ parts: [{ text: "<EMAIL_1>" }] }],
    });
    expect(events[2]).toMatchObject({
      type: "model_response",
      content: [{ text: "<EMAIL_2>" }],
    });
    expect(JSON.stringify(events)).not.toContain(requestCanary);
    expect(JSON.stringify(events)).not.toContain(responseCanary);
    await expect(store.readUsageLedger("team", "day", [0])).resolves.toMatchObject([
      { costMicros: 5, unknownCostCount: 0 },
    ]);
  });

  it("fails closed when the wrapped store lacks reservation operations", async () => {
    const store = new PiiEventStore(createInnerStore(), createTokenizer());
    const attemptId = Id.parse(ids.next());
    const settlement: SpendReservationSettlement = {
      runId,
      attemptId,
      cost: { version: 1, state: "known", amountMicros: 5 },
      responseHash: "c".repeat(64),
    };

    await expect(
      store.reserveSpend(spendInput(attemptId), spendRequest(attemptId, "synthetic"), 0),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    expect(() => store.markSpendDispatching(attemptId)).toThrow(PiiStorageFailedError);
    expect(() => store.releaseSpend(attemptId)).toThrow(PiiStorageFailedError);
    await expect(
      store.settleSpend(settlement, spendResponse(attemptId, "synthetic"), 0, {
        usageUpdates: [],
      }),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    expect(() => store.markSpendUncertain(attemptId, "spend_reservation_uncertain")).toThrow(
      PiiStorageFailedError,
    );
    await expect(store.head(runId)).resolves.toBe(0);
  });

  it("forwards hashed idempotency claims without treating them as event content", async () => {
    const inner = createInnerStore();
    const store = new PiiEventStore(inner, createTokenizer());
    const keyHash = "d".repeat(64);

    await expect(store.claimIdempotencyKey(keyHash, runId, 10)).resolves.toBe(runId);
    await expect(
      store.takeoverIdempotencyKey(keyHash, {
        expectedRunId: runId,
        runId,
        createdAt: 20,
        staleBefore: 10,
      }),
    ).resolves.toBe(false);
    await expect(store.releaseIdempotencyKey(keyHash, runId)).resolves.toBeUndefined();
  });

  it("tokenizes unmarked event content and reports a metadata-only summary", async () => {
    const inner = createInnerStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });
    const rawEmail = canary();

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).resolves.toEqual({ nextSeq: 2 });

    const events = await collect(store.read(runId));
    expect(events.map(({ seq }) => seq)).toEqual([0, 1]);
    expect(events[1]).toMatchObject({ type: "run_input", input: { text: "<EMAIL_1>" } });
    expect(summaries).toEqual([
      { boundary: "storage", action: "tokenize", entities: [{ type: "email", count: 1 }] },
    ]);
    expect(JSON.stringify(summaries)).not.toContain(rawEmail);
  });

  it("tokenizes content before atomically appending usage-ledger updates", async () => {
    const inner = createInnerStore();
    const store = new PiiEventStore(inner, createTokenizer());
    const rawEmail = canary("quota-usage");

    await store.appendWithUsage(runId, [runCreated(), runInput({ text: rawEmail })], 0, {
      usageUpdates: [
        { quotaId: "team", period: "day", periodStart: 0, costMicros: 5, runsStarted: 0 },
      ],
    });

    const events = await collect(store.read(runId));
    expect(events[1]).toMatchObject({ type: "run_input", input: { text: "<EMAIL_1>" } });
    expect(JSON.stringify(events)).not.toContain(rawEmail);
    await expect(store.readUsageLedger("team", "day", [0])).resolves.toEqual([
      {
        quotaId: "team",
        period: "day",
        periodStart: 0,
        costMicros: 5,
        unknownCostCount: 0,
        runsStarted: 0,
      },
    ]);
  });

  it("skips scanning marked events and marked content fields", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
    const value = canary("already-tokenized");
    const markedField = markSanitized({ text: value });
    const firstEvent = markSanitized(runInput({ text: value }));
    const secondEvent = runInput(markedField);

    await store.append(runId, [runCreated(), firstEvent, secondEvent], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("skips scanning a sanitized token in a primitive tool result field", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
    const result = {
      ...common(),
      type: "tool_result" as const,
      callId: Id.parse(ids.next()),
      toolId: "test.tool",
      outcome: "ok" as const,
      latencyMs: 0,
      result: "<EMAIL_1>",
    };

    await store.append(runId, [runCreated(), markSanitizedField(result, "result")], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("fails closed without writing when detection fails", async () => {
    const inner = createInnerStore();
    const rawEmail = canary("detector-failure");
    const detectorFailure = new Error(rawEmail);
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw detectorFailure;
      }),
    );

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("fails closed without exposing vault errors or writing events", async () => {
    const inner = createInnerStore();
    const vault = new InMemoryVault();
    const rawEmail = canary("vault-failure");
    vi.spyOn(vault, "put").mockRejectedValue(new Error(rawEmail));
    const store = new PiiEventStore(inner, createTokenizer(undefined, vault));

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("converts summary callback failures to a safe storage error before writing", async () => {
    const inner = createInnerStore();
    const store = new PiiEventStore(inner, createTokenizer(), () => {
      throw new Error(canary("summary-failure"));
    });

    await expect(
      store.append(runId, [runCreated(), runInput({ text: canary("summary-failure-event") })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("scans snapshot context and plan before writing", async () => {
    const inner = createInnerStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });
    const contextCanary = canary("context");
    const planCanary = canary("plan");
    const result = await store.appendWithSnapshot(
      runId,
      [runCreated(), checkpointWritten()],
      0,
      snapshot(contextCanary, planCanary),
    );

    expect(result.nextSeq).toBe(2);
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({
      context: { text: "<EMAIL_1>" },
      plan: { text: "<EMAIL_2>" },
    });
    expect((await collect(store.read(runId))).map((event) => event.type)).toEqual([
      "run_created",
      "checkpoint_written",
    ]);
    expect(summaries).toHaveLength(2);
    expect(JSON.stringify(summaries)).not.toContain(contextCanary);
    expect(JSON.stringify(summaries)).not.toContain(planCanary);
  });

  it("does not scan pii_action events", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
    const action: NewEvent = {
      ...common(),
      type: "pii_action",
      boundary: "storage",
      action: "tokenized",
      entities: [{ type: "email", count: 1 }],
    };

    await store.append(runId, [runCreated(), action], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("does not persist raw snapshot content if tokenization fails", async () => {
    const inner = createInnerStore();
    const rawEmail = canary("snapshot-failure");
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw new Error(rawEmail);
      }),
    );

    await expect(
      store.appendWithSnapshot(
        runId,
        [runCreated(), checkpointWritten()],
        0,
        snapshot(rawEmail, canary("snapshot-failure-plan")),
      ),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
    await expect(inner.latestSnapshot(runId)).resolves.toBeUndefined();
  });

  it("restores protected MRTR keys and state after a PiiEventStore restart", async () => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer(undefined, vault);
    const config = PiiConfigSchema.parse({});
    const callId = Id.parse(ids.next());
    const inputKeyCanary = canary("mrtr-key");
    const requestStateCanary = "\t opaque-request-state-canary \n";
    let protectedInputKey: string | undefined;
    let protectedRequestState: string | undefined;
    const producer: PiiToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: async (_call, context) => {
        const protect = context.protectInputMetadata;
        if (protect === undefined) {
          throw new Error("Expected the opaque-input protector.");
        }
        protectedInputKey = await protect(inputKeyCanary);
        protectedRequestState = await protect(requestStateCanary);
        return { outcome: "ok", result: null };
      },
    };
    const resolver = new AuditingVaultResolver(vault, () => undefined);
    const dependencies = { config, tokenizer, resolver };
    const producerPort = new PiiToolPort(producer, dependencies);
    await producerPort.execute(
      { callId, toolId: Code.parse("mcp_test.tool"), args: {} },
      { runId, signal: new AbortController().signal },
    );
    if (protectedInputKey === undefined || protectedRequestState === undefined) {
      throw new Error("Expected protected MRTR metadata.");
    }

    const innerStore = createInnerStore();
    const store = new PiiEventStore(innerStore, tokenizer);
    await store.append(
      runId,
      [
        runCreated(),
        {
          ...common(),
          type: "input_requested",
          requestId: Id.parse(ids.next()),
          source: "mcp_mrtr",
          serverId: "mcp_test",
          callId,
          inputKey: protectedInputKey,
          round: 1,
          mode: "form",
          message: "Provide an answer",
          schema: { type: "object", properties: { answer: { type: "string" } } },
          requestState: protectedRequestState,
        },
      ],
      0,
    );
    await store.appendWithSnapshot(
      runId,
      [
        {
          ...common(),
          type: "checkpoint_written",
          checkpointId: snapshotId,
          atSeq: 2,
          traceparent: `00-${traceId}-${spanId}-01`,
        },
      ],
      2,
      {
        snapshotId,
        runId,
        v: 1,
        atSeq: 2,
        createdAt: 10,
        traceparent: `00-${traceId}-${spanId}-01`,
        context: { inputKey: protectedInputKey, requestState: protectedRequestState },
        plan: null,
      },
    );

    const restartedStore = new PiiEventStore(innerStore, tokenizer);
    const persistedEvents = await collect(restartedStore.read(runId));
    const persistedSnapshot = await restartedStore.latestSnapshot(runId);
    const serialized = JSON.stringify({ persistedEvents, persistedSnapshot });
    expect(serialized).not.toContain(inputKeyCanary);
    expect(serialized).not.toContain(requestStateCanary);
    const persistedRequest = persistedEvents.find(
      (event): event is Extract<Event, { type: "input_requested" }> =>
        event.type === "input_requested",
    );
    if (persistedRequest?.type !== "input_requested") {
      throw new Error("Expected the persisted input request.");
    }

    const answer = await tokenizer.tokenizeJson(
      runId,
      { answer: "human@example.test" },
      { boundary: "storage", destination: "any" },
    );
    const dispatchedRetries: NonNullable<PiiToolContext["inputRetry"]>[] = [];
    const auditRecords: VaultAudit[] = [];
    let auditCountAtDispatch = 0;
    const consumer: PiiToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: (_call, context) => {
        if (context.inputRetry !== undefined) {
          dispatchedRetries.push(context.inputRetry);
        }
        auditCountAtDispatch = auditRecords.length;
        expect(auditRecords.length).toBeGreaterThan(0);
        return Promise.resolve({ outcome: "ok", result: null });
      },
    };
    const restartedPort = new PiiToolPort(consumer, {
      config,
      tokenizer,
      resolver: new AuditingVaultResolver(vault, () => undefined),
    });
    await restartedPort.execute(
      { callId, toolId: Code.parse("mcp_test.tool"), args: {} },
      {
        runId,
        signal: new AbortController().signal,
        inputRetry: {
          inputResponses: {
            [persistedRequest.inputKey ?? ""]: { action: "accept", answer: answer.value },
          },
          round: persistedRequest.round,
          ...(typeof persistedRequest.requestState === "string"
            ? { requestState: persistedRequest.requestState }
            : {}),
        },
        recordVaultAudit: (audit) => {
          auditRecords.push(audit);
        },
      },
    );

    expect(dispatchedRetries).toEqual([
      {
        inputResponses: {
          [inputKeyCanary]: { action: "accept", answer: { answer: "human@example.test" } },
        },
        round: 1,
        requestState: requestStateCanary,
      },
    ]);
    expect(auditRecords.map(({ toolId }) => toolId)).toEqual(["mcp_test.tool", "mcp_test.tool"]);
    expect(auditRecords.map(({ entities }) => entities[0]?.type)).toEqual(["mcp_input", "email"]);
    expect(auditCountAtDispatch).toBe(2);
  });
});
