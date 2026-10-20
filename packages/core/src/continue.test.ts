// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  Code,
  FakeClock,
  Id,
  Principal,
  RunConfigSchema,
  SequentialIdGenerator,
  Sha256Hex,
  type Event,
  type NewEvent,
  type RunStatus,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { InMemoryVault } from "@harness/vault";
import { describe, expect, it } from "vitest";
import {
  ContinuationChainTooLongError,
  inheritedBudgets,
  loadContinuationChain,
  RunNotTerminalError,
} from "./continue.js";
import { createRuntime } from "./runtime.js";
import { FakeModelPort } from "./testing/fake-model.js";
import type { ModelCompletion } from "./ports.js";
import { RunScopeRegistry } from "./subagent/scope.js";

const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const hash = Sha256Hex.parse("c".repeat(64));

function completedResponse(text: string, costMicros = 300): ModelCompletion {
  return {
    parts: [{ type: "text", text }],
    usage: { inputTokens: 2, outputTokens: 3, costMicros },
    finishReason: "stop",
    provider: "test",
    model: "test",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function envelope(
  runId: Id,
  seq: number,
  ts: number,
): Pick<Event, "runId" | "seq" | "ts" | "v" | "traceId" | "spanId" | "segmentId"> {
  return { runId, seq, ts, v: 1, traceId, spanId, segmentId: runId };
}

async function seedRun(
  store: InMemoryEventStore,
  runId: Id,
  status: RunStatus,
  options: { readonly continuationOf?: Id; readonly parentRunId?: Id } = {},
): Promise<void> {
  const events: NewEvent[] = [
    {
      ...envelope(runId, 0, 100),
      type: "run_created",
      configHash: hash,
      policyVersion: Code.parse("test"),
      ...(options.continuationOf === undefined ? {} : { continuationOf: options.continuationOf }),
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    },
    {
      ...envelope(runId, 1, 101),
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "start",
    },
  ];
  if (status !== "running") {
    events.push({
      ...envelope(runId, 2, 102),
      type: "run_status_changed",
      from: "running",
      to: status,
      reason: "test",
    });
  }
  await store.append(runId, events, 0);
}

function runtimeOptions(
  store: InMemoryEventStore,
  model: FakeModelPort,
  run: Record<string, unknown> = {},
  scopes = new RunScopeRegistry(),
) {
  return {
    config: { run: RunConfigSchema.parse(run) },
    overrides: {
      store,
      transientVault: true,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      model,
      scopeRegistry: scopes,
    },
  };
}

async function readEvents(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("continueRun", () => {
  it("continues a completed run without changing its log and retains token scope", async () => {
    const store = new InMemoryEventStore();
    const scopes = new RunScopeRegistry();
    const model = new FakeModelPort([
      completedResponse("original answer"),
      completedResponse("follow-up answer"),
    ]);
    const runtime = await createRuntime(
      runtimeOptions(store, model, {}, scopes).config,
      runtimeOptions(store, model, {}, scopes).overrides,
    );
    const vault = new InMemoryVault();
    try {
      const original = await runtime.run("original question", {
        requestedBy: Principal.parse("cli.requester"),
      });
      const originalId = original.events[0]?.runId;
      if (originalId === undefined) {
        throw new Error("Expected an original run.");
      }
      const originalEvents = await readEvents(store, originalId);
      const token = await vault.put(originalId, Code.parse("email"), "synthetic@example.test");

      const continued = await runtime.continueRun(originalId, { goal: "follow-up question" });
      const continuationId = continued.events[0]?.runId;
      if (continuationId === undefined) {
        throw new Error("Expected a continuation run.");
      }
      const continuation = await readEvents(store, continuationId);
      const messages = model.requests[1]?.request.messages.flatMap(({ parts }) => parts);

      expect(continued.status).toBe("completed");
      expect(await readEvents(store, originalId)).toEqual(originalEvents);
      expect(continuation[0]).toMatchObject({
        type: "run_created",
        continuationOf: originalId,
        scopeId: originalId,
        requestedBy: "cli.requester",
      });
      expect(continuation.find((event) => event.type === "run_input")).toMatchObject({
        type: "run_input",
        inputKind: "follow_up",
      });
      expect(messages).toEqual(
        expect.arrayContaining([
          { type: "text", text: "original question" },
          { type: "text", text: "original answer" },
          { type: "text", text: '{"goal":"follow-up question"}' },
        ]),
      );
      await expect(
        vault.resolve(scopes.scopeOf(continuationId), token, { boundary: "ui" }),
      ).resolves.toBe("synthetic@example.test");
    } finally {
      await runtime.close();
    }
  });

  it.each(["running", "suspended", "cancelled", "failed"] as const)(
    "rejects a %s run without appending to it",
    async (status) => {
      const store = new InMemoryEventStore();
      const runId = Id.parse("99999999999999999999999991");
      await seedRun(store, runId, status);
      const runtime = await createRuntime(
        runtimeOptions(store, new FakeModelPort([completedResponse("not used")])).config,
        runtimeOptions(store, new FakeModelPort([completedResponse("not used")])).overrides,
      );
      const head = await store.head(runId);
      try {
        await expect(runtime.continueRun(runId, { goal: "follow-up" })).rejects.toBeInstanceOf(
          RunNotTerminalError,
        );
        expect(await store.head(runId)).toBe(head);
      } finally {
        await runtime.close();
      }
    },
  );

  it("allows failed runs only when the continuation policy explicitly enables them", async () => {
    const store = new InMemoryEventStore();
    const runId = Id.parse("99999999999999999999999992");
    await seedRun(store, runId, "failed");
    const runtimeOptionsValue = runtimeOptions(
      store,
      new FakeModelPort([completedResponse("continued failure")]),
      { continuations: { allowFromFailed: true } },
    );
    const runtime = await createRuntime(runtimeOptionsValue.config, runtimeOptionsValue.overrides);
    try {
      await expect(runtime.continueRun(runId, { goal: "follow-up" })).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects a continuation that would exceed the configured chain length", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelPort([completedResponse("original answer")]);
    const configured = runtimeOptions(store, model, {
      continuations: { maxChainLength: 1 },
    });
    const runtime = await createRuntime(configured.config, configured.overrides);
    try {
      const original = await runtime.run("original");
      const originalId = original.events[0]?.runId;
      if (originalId === undefined) {
        throw new Error("Expected an original run.");
      }
      const head = await store.head(originalId);
      await expect(runtime.continueRun(originalId, { goal: "follow-up" })).rejects.toBeInstanceOf(
        ContinuationChainTooLongError,
      );
      expect(await store.head(originalId)).toBe(head);
    } finally {
      await runtime.close();
    }
  });

  it("loads source and ancestor logs oldest-first for continuation-aware consumers", async () => {
    const store = new InMemoryEventStore();
    const rootId = Id.parse("99999999999999999999999996");
    const childId = Id.parse("99999999999999999999999997");
    await seedRun(store, rootId, "completed");
    await seedRun(store, childId, "completed", { continuationOf: rootId });

    const chain = await loadContinuationChain(store, childId, 4);
    expect(chain.map((events) => events[0]?.runId)).toEqual([rootId, childId]);
    await expect(loadContinuationChain(store, childId, 1)).rejects.toBeInstanceOf(
      ContinuationChainTooLongError,
    );
  });

  it("rejects a missing run and a corrupt cyclic continuation chain", async () => {
    const store = new InMemoryEventStore();
    const missingId = Id.parse("99999999999999999999999998");
    const firstId = Id.parse("99999999999999999999999999");
    const secondId = Id.parse("99999999999999999999999990");
    await seedRun(store, firstId, "completed", { continuationOf: secondId });
    await seedRun(store, secondId, "completed", { continuationOf: firstId });

    await expect(loadContinuationChain(store, missingId, 4)).rejects.toMatchObject({
      code: "run_not_found",
    });
    await expect(loadContinuationChain(store, firstId, 4)).rejects.toMatchObject({
      code: "corrupt_log",
    });
  });

  it("keeps branches independent when continuing the same run more than once", async () => {
    const store = new InMemoryEventStore();
    const model = new FakeModelPort([
      completedResponse("source answer"),
      completedResponse("first branch answer"),
      completedResponse("second branch answer"),
    ]);
    const configured = runtimeOptions(store, model);
    const runtime = await createRuntime(configured.config, configured.overrides);
    try {
      const original = await runtime.run("source");
      const originalId = original.events[0]?.runId;
      if (originalId === undefined) {
        throw new Error("Expected an original run.");
      }
      const first = await runtime.continueRun(originalId, { goal: "branch one" });
      const second = await runtime.continueRun(originalId, { goal: "branch two" });
      const firstId = first.events[0]?.runId;
      const secondId = second.events[0]?.runId;
      if (firstId === undefined || secondId === undefined) {
        throw new Error("Expected two continuation runs.");
      }

      expect(firstId).not.toBe(secondId);
      expect(first.events[0]).toMatchObject({ continuationOf: originalId });
      expect(second.events[0]).toMatchObject({ continuationOf: originalId });
      expect(model.requests[1]?.request.messages.flatMap(({ parts }) => parts)).toEqual(
        expect.arrayContaining([{ type: "text", text: '{"goal":"branch one"}' }]),
      );
      expect(model.requests[1]?.request.messages.flatMap(({ parts }) => parts)).not.toContainEqual({
        type: "text",
        text: '{"goal":"branch two"}',
      });
      expect(model.requests[2]?.request.messages.flatMap(({ parts }) => parts)).not.toContainEqual({
        type: "text",
        text: '{"goal":"branch one"}',
      });
    } finally {
      await runtime.close();
    }
  });

  it("restores a legacy child run's scope through its parent before continuing", async () => {
    const store = new InMemoryEventStore();
    const parentId = Id.parse("99999999999999999999999993");
    const childId = Id.parse("99999999999999999999999994");
    await seedRun(store, parentId, "completed");
    await seedRun(store, childId, "completed", { parentRunId: parentId });
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const token = await vault.put(parentId, Code.parse("email"), "legacy@example.test");
    const configured = runtimeOptions(
      store,
      new FakeModelPort([completedResponse("child continuation")]),
      {},
      scopes,
    );
    const runtime = await createRuntime(configured.config, configured.overrides);
    try {
      const continued = await runtime.continueRun(childId, { goal: "follow-up" });
      const continuationId = continued.events[0]?.runId;
      if (continuationId === undefined) {
        throw new Error("Expected a continuation run.");
      }
      expect(scopes.scopeOf(continuationId)).toBe(parentId);
      await expect(
        vault.resolve(scopes.scopeOf(continuationId), token, { boundary: "ui" }),
      ).resolves.toBe("legacy@example.test");
    } finally {
      await runtime.close();
    }
  });
});

describe("inherited continuation budgets", () => {
  it.each([
    { costMicros: 1_000_000, observed: 1_000_000, label: "exactly at" },
    { costMicros: 1_100_000, observed: 1_100_000, label: "over" },
  ])(
    "fails before a model call when ancestor cost is $label the limit",
    async ({ costMicros, observed }) => {
      const store = new InMemoryEventStore();
      const model = new FakeModelPort([
        completedResponse("source answer", costMicros),
        completedResponse("must not be requested"),
      ]);
      const configured = runtimeOptions(store, model, {
        budgets: { maxSteps: 10, maxCostUsd: 1, maxWallClockMs: 100_000 },
        continuations: { inheritBudgets: true },
      });
      const runtime = await createRuntime(configured.config, configured.overrides);
      try {
        const original = await runtime.run("source");
        const originalId = original.events[0]?.runId;
        if (originalId === undefined) {
          throw new Error("Expected an original run.");
        }

        const continued = await runtime.continueRun(originalId, { goal: "follow-up" });

        expect(continued.status).toBe("failed");
        expect(model.requests).toHaveLength(1);
        expect(continued.events.slice(-2)).toMatchObject([
          { type: "budget_exceeded", budget: "cost", limit: 1_000_000, observed },
          {
            type: "run_status_changed",
            from: "running",
            to: "failed",
            reason: "budget_exceeded",
          },
        ]);
      } finally {
        await runtime.close();
      }
    },
  );

  it("subtracts ancestor steps, active time, and cost while respecting suspension policy", () => {
    const runId = Id.parse("99999999999999999999999995");
    const events: Event[] = [
      {
        ...envelope(runId, 0, 100),
        type: "run_created",
        configHash: hash,
        policyVersion: "test",
        depth: 0,
      },
      {
        ...envelope(runId, 1, 101),
        type: "run_status_changed",
        from: "pending",
        to: "running",
        reason: "start",
      },
      {
        ...envelope(runId, 2, 110),
        type: "run_status_changed",
        from: "running",
        to: "suspended",
        reason: "awaiting_approval",
      },
      {
        ...envelope(runId, 3, 210),
        type: "run_status_changed",
        from: "suspended",
        to: "running",
        reason: "resumed",
      },
      {
        ...envelope(runId, 4, 215),
        type: "model_response",
        requestId: runId,
        provider: "test",
        model: "test",
        inputTokens: 2,
        outputTokens: 3,
        costMicros: 300,
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [],
        providerBlobs: null,
      },
      {
        ...envelope(runId, 5, 220),
        type: "run_status_changed",
        from: "running",
        to: "completed",
        reason: "final_answer",
      },
    ];
    const budgets = RunConfigSchema.parse({
      budgets: { maxSteps: 10, maxCostUsd: 1, maxWallClockMs: 1_000 },
    }).budgets;

    expect(inheritedBudgets(budgets, [events])).toEqual({
      ...budgets,
      maxSteps: 9,
      maxCostUsd: 0.9997,
      maxWallClockMs: 980,
    });
    expect(
      inheritedBudgets({ ...budgets, countSuspendedTime: true }, [events]).maxWallClockMs,
    ).toBe(880);
    const withoutCost = RunConfigSchema.parse({ budgets: { maxSteps: 10 } }).budgets;
    expect(inheritedBudgets(withoutCost, [events])).not.toHaveProperty("maxCostUsd");
  });
});

describe("continuation tracing", () => {
  it("links the new root span to the source root and records its continuation id", async () => {
    trace.disable();
    otelContext.disable();
    const { provider, getFinishedSpans } = createTestSpanCollector();
    trace.setGlobalTracerProvider(provider);
    otelContext.setGlobalContextManager(createTestContextManager());
    const store = new InMemoryEventStore();
    const model = new FakeModelPort([
      completedResponse("source answer"),
      completedResponse("continued answer"),
    ]);
    const configured = runtimeOptions(store, model);
    const runtime = await createRuntime(configured.config, configured.overrides);
    try {
      const original = await runtime.run("source");
      const sourceRoot = original.events[0];
      if (sourceRoot?.type !== "run_created") {
        throw new Error("Expected a source root event.");
      }
      await runtime.continueRun(sourceRoot.runId, { goal: "follow-up" });
      await provider.forceFlush();
      const continuationSpan = getFinishedSpans().find(
        (span) =>
          span.name === "harness.run" &&
          span.attributes["harness.run.continuation_of"] === sourceRoot.runId,
      );

      expect(continuationSpan?.links[0]?.context).toMatchObject({
        traceId: sourceRoot.traceId,
        spanId: sourceRoot.spanId,
      });
    } finally {
      await runtime.close();
      await provider.shutdown();
      trace.disable();
      otelContext.disable();
    }
  });
});
