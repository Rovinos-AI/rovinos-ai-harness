// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id, RunConfigSchema, type NewEvent } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import { InMemoryEventStore } from "@rovinos/store";
import { describe, expect, it } from "vitest";
import { NaiveContext } from "./context/naive-context.js";
import type { ContextPort, ModelCompletion, ModelPort, ToolPort } from "./ports.js";
import { createRuntime } from "./runtime.js";
import { RunScopeRegistry } from "./subagent/scope.js";

const rootRunId = Id.parse("88888888888888888888888888");
const childRunId = Id.parse("99999999999999999999999999");
const parentCallId = Id.parse("11111111111111111111111111");
const segmentId = Id.parse("22222222222222222222222222");
const hash = "a".repeat(64);
const envelope = {
  runId: childRunId,
  ts: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId,
};

function completion(): ModelCompletion {
  return {
    parts: [{ type: "text", text: "resumed" }],
    usage: { inputTokens: 1, outputTokens: 1 },
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

async function seedRun(store: EventStore, persistScope: boolean): Promise<void> {
  if (!persistScope) {
    await store.append(
      rootRunId,
      [
        {
          runId: rootRunId,
          ts: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          type: "run_created",
          v: 1,
          configHash: hash,
          policyVersion: "test",
          scopeId: rootRunId,
          depth: 0,
        },
      ],
      0,
    );
  }
  const childEvents: NewEvent[] = [
    {
      ...envelope,
      type: "run_created",
      v: 1,
      configHash: hash,
      policyVersion: "test",
      parentRunId: rootRunId,
      parentCallId,
      ...(persistScope ? { scopeId: rootRunId } : {}),
      depth: 1,
    },
    {
      ...envelope,
      ts: 2,
      type: "run_input",
      v: 1,
      input: "resume this child",
      inputKind: "initial",
    },
    {
      ...envelope,
      ts: 3,
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    },
  ];
  await store.append(childRunId, childEvents, 0);
}

async function resumeChild(persistScope: boolean): Promise<{
  readonly observedScope: Id | undefined;
  readonly scope: Id;
}> {
  const store = new InMemoryEventStore();
  await seedRun(store, persistScope);
  const scopes = new RunScopeRegistry();
  const baseContext = new NaiveContext();
  let observedScope: Id | undefined;
  const context: ContextPort = {
    build: (events) => baseContext.build(events),
    estimate: (messages) => baseContext.estimate(messages),
    observeModelResponse: (model, estimated, actual) => {
      baseContext.observeModelResponse(model, estimated, actual);
    },
    snapshot: () => baseContext.snapshot(),
    restore: async (snapshot, events) => {
      observedScope = scopes.scopeOf(childRunId);
      await baseContext.restore(snapshot, events);
    },
  };
  const model: ModelPort = { complete: () => Promise.resolve(completion()) };
  const tool: ToolPort = {
    describe: () => undefined,
    execute: () => Promise.resolve({ outcome: "ok", result: null }),
  };
  const runtime = await createRuntime(
    { run: RunConfigSchema.parse({}) },
    {
      store,
      transientVault: true,
      clock: new FakeClock(4),
      model,
      tool,
      context,
      scopeRegistry: scopes,
    },
  );
  try {
    const result = await runtime.resume(childRunId);
    expect(result.status).toBe("completed");
    return { observedScope, scope: scopes.scopeOf(childRunId) };
  } finally {
    await runtime.close();
  }
}

describe("resume token scopes", () => {
  it("restores the persisted child scope before context restoration", async () => {
    const result = await resumeChild(true);

    expect(result).toEqual({ observedScope: rootRunId, scope: rootRunId });
  });

  it("derives legacy child scope by walking to the root run", async () => {
    const result = await resumeChild(false);

    expect(result).toEqual({ observedScope: rootRunId, scope: rootRunId });
  });
});
