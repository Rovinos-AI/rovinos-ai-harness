// SPDX-License-Identifier: Apache-2.0
import type { ModelPort, PolicyPort, ToolPort } from "@harness/core";
import { CrashingEventStore } from "@harness/core/testing";
import { HarnessConfigSchema } from "@harness/config";
import { InMemoryEventStore, SqliteEventStore } from "@harness/store";
import {
  Code,
  FakeClock,
  Id,
  Principal,
  SequentialIdGenerator,
  type Event,
} from "@harness/schemas";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./index.js";
import { GetRunContentOptionsSchema, ListRunsFilterSchema } from "./types.js";
import type { Harness } from "./types.js";
import type { EventStore } from "@harness/store";

function fakeModel(responses?: readonly string[]): ModelPort {
  let index = 0;
  return {
    complete: () => {
      const text = responses?.[index] ?? "synthetic completion";
      index += 1;
      return Promise.resolve({
        parts: [{ type: "text", text }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        provider: Code.parse("test"),
        model: Code.parse("test-model"),
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
    },
  };
}

function approvalModel(): ModelPort {
  let first = true;
  return {
    complete: () => {
      if (first) {
        first = false;
        return Promise.resolve({
          parts: [
            {
              type: "tool_call",
              callId: Id.parse("00000000000000000000000091"),
              toolId: Code.parse("synthetic.tool"),
              args: { value: "synthetic" },
            },
          ],
          usage: { inputTokens: 2, outputTokens: 3 },
          finishReason: "tool_calls",
          provider: Code.parse("test"),
          model: Code.parse("test-model"),
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        });
      }
      return Promise.resolve({
        parts: [{ type: "text", text: "synthetic completion" }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        provider: Code.parse("test"),
        model: Code.parse("test-model"),
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
    },
  };
}

const askPolicy: PolicyPort = {
  version: Code.parse("test"),
  decide: () => ({
    decision: "ask",
    ruleId: Code.parse("approval"),
    reason: Code.parse("manual_review"),
    editable: [],
  }),
};
const separationAskPolicy: PolicyPort = {
  ...askPolicy,
  decide: (...args) => ({ ...askPolicy.decide(...args), separationOfDuties: true }),
};

const fakeTool: ToolPort = {
  describe: () => ({ idempotent: true, timeoutMs: 1000 }),
  execute: () => Promise.resolve({ outcome: "ok", result: "synthetic tool result" }),
};

const harnesses: Harness[] = [];

function idsStartingAt(start: bigint) {
  let nextId = start;
  return {
    next: () => Id.parse((nextId++).toString().padStart(26, "0")),
  };
}

async function createTestHarness(
  options: {
    readonly model?: ModelPort;
    readonly approval?: boolean;
    readonly piiEnabled?: boolean;
    readonly correlationEnabled?: boolean;
    readonly globalSeparation?: boolean;
    readonly ruleSeparation?: boolean;
    readonly store?: InMemoryEventStore;
    readonly idStart?: bigint;
  } = {},
): Promise<{ readonly harness: Harness; readonly store: InMemoryEventStore }> {
  const store = options.store ?? new InMemoryEventStore();
  const harness = await createHarness({
    config: HarnessConfigSchema.parse({
      ...(options.piiEnabled === false ? { pii: { enabled: false } } : {}),
      ...(options.correlationEnabled === true
        ? { telemetry: { correlation: { enabled: true } } }
        : {}),
      ...(options.globalSeparation === true
        ? { policy: { approvals: { separationOfDuties: true } } }
        : {}),
    }),
    overrides: {
      store,
      clock: new FakeClock(10_000),
      ids:
        options.idStart === undefined
          ? new SequentialIdGenerator()
          : idsStartingAt(options.idStart),
      transientVault: true,
      model: options.model ?? (options.approval === true ? approvalModel() : fakeModel()),
      ...(options.approval === true
        ? {
            policy: options.ruleSeparation === true ? separationAskPolicy : askPolicy,
            tool: fakeTool,
          }
        : {}),
    },
  });
  harnesses.push(harness);
  return { harness, store };
}

async function readStoredEvents(store: InMemoryEventStore, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(Id.parse(runId))) {
    events.push(event);
  }
  return events;
}

class DelayedAppendStore extends InMemoryEventStore {
  private releaseAppend: () => void = () => undefined;
  private signalAppendStarted: () => void = () => undefined;
  private readonly appendGate = new Promise<void>((resolve) => {
    this.releaseAppend = resolve;
  });
  readonly appendStarted = new Promise<void>((resolve) => {
    this.signalAppendStarted = resolve;
  });

  release(): void {
    this.releaseAppend();
  }

  override async append(
    ...args: Parameters<InMemoryEventStore["append"]>
  ): ReturnType<InMemoryEventStore["append"]> {
    this.signalAppendStarted();
    await this.appendGate;
    return super.append(...args);
  }
}

class OrphaningCrashStore extends CrashingEventStore {
  override claimIdempotencyKey(
    keyHash: Parameters<EventStore["claimIdempotencyKey"]>[0],
    runId: Id,
    createdAt: number,
  ): Promise<Id> {
    return super.claimIdempotencyKey(keyHash, runId, createdAt - 30_001);
  }

  override releaseIdempotencyKey(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitForRun(harness: Harness, runId: string, status?: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const run = await harness.getRun(runId);
      if (status === undefined || run.status === status) {
        return run;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error("Run did not reach the expected state.");
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("@harness/sdk", () => {
  it("starts detached runs idempotently and exposes metadata only", async () => {
    const { harness, store } = await createTestHarness();
    const request = {
      goal: "Synthetic task",
      metadata: { source: "sdk" },
      role: Code.parse("worker"),
      requestedBy: Principal.parse("cli.demo"),
      idempotencyKey: "repeat-this-request",
    };

    const first = await harness.startRun(request);
    const second = await harness.startRun(request);

    expect(second.runId).toBe(first.runId);
    const storedEvents = await readStoredEvents(store, first.runId);
    const runInput = storedEvents.find((event) => event.type === "run_input");
    expect(storedEvents.find((event) => event.type === "run_created")).toMatchObject({
      requestedBy: "cli.demo",
    });
    expect(runInput?.type).toBe("run_input");
    if (runInput?.type !== "run_input") {
      throw new Error("Expected the initial run input.");
    }
    expect(runInput.input).toEqual({ goal: request.goal, metadata: request.metadata });
    expect(JSON.stringify(runInput.input)).not.toContain("requestedBy");
    expect(JSON.stringify(runInput.input)).not.toContain("role");
    expect(first.status).toBe("pending");
    const run = await waitForRun(harness, first.runId, "completed");
    expect(run).toMatchObject({
      runId: first.runId,
      status: "completed",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(JSON.stringify(run)).not.toContain("Synthetic task");
    expect(JSON.stringify(run.recentEvents)).not.toContain("cli.demo");
    expect(JSON.stringify(run.recentEvents)).not.toContain("requestedByPseudonym");
    expect((await harness.startRun(request)).status).toBe("completed");
  });

  it("pseudonymizes requester and approver only when correlation is enabled", async () => {
    const { harness } = await createTestHarness({ approval: true, correlationEnabled: true });
    const started = await harness.startRun({
      goal: "Synthetic approval task",
      requestedBy: Principal.parse("cli.requester"),
    });
    const pending = await waitForRun(harness, started.runId, "suspended");
    const approvalId = pending.pendingApprovals[0];
    if (approvalId === undefined) {
      throw new Error("Expected a pending approval.");
    }

    await harness.resolveApproval(approvalId, "approve", {
      principal: Principal.parse("cli.approver"),
    });
    await harness.resumeRun(started.runId);
    const resolved = await waitForRun(harness, started.runId, "completed");
    const serialized = JSON.stringify(resolved.recentEvents);

    expect(serialized).not.toContain("cli.requester");
    expect(serialized).not.toContain("cli.approver");
    expect(resolved.recentEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_created",
        requestedByPseudonym: expect.stringMatching(/^p_[a-z2-7]{26}$/u),
      }),
    );
    expect(resolved.recentEvents).toContainEqual(
      expect.objectContaining({
        kind: "approval_wait",
        approverPseudonym: expect.stringMatching(/^p_[a-z2-7]{26}$/u),
      }),
    );
  });

  it.each([
    { scope: "rule", options: { approval: true, ruleSeparation: true } },
    { scope: "global", options: { approval: true, globalSeparation: true } },
  ])("enforces separation of duties configured $scope", async ({ options }) => {
    const { harness, store } = await createTestHarness(options);
    const requestedBy = Principal.parse("cli.requester");
    const started = await harness.startRun({ goal: "Synthetic separation task", requestedBy });
    const pending = await waitForRun(harness, started.runId, "suspended");
    const approvalId = pending.pendingApprovals[0];
    if (approvalId === undefined) {
      throw new Error("Expected a pending approval.");
    }

    await expect(
      harness.resolveApproval(approvalId, "approve", { principal: requestedBy }),
    ).rejects.toMatchObject({ code: "approver_is_requester" });
    await harness.resolveApproval(approvalId, "approve", {
      principal: Principal.parse("cli.approver"),
    });
    await harness.resumeRun(started.runId);

    expect(
      (await readStoredEvents(store, started.runId)).find(
        (event) => event.type === "approval_resolved",
      ),
    ).toMatchObject({ decidedBy: "human", approverId: "cli.approver" });
  });

  it("deduplicates concurrent starts with the same idempotency key", async () => {
    const { harness } = await createTestHarness();
    const request = { goal: "Synthetic concurrent task", idempotencyKey: "concurrent-key" };

    const [first, second] = await Promise.all([
      harness.startRun(request),
      harness.startRun(request),
    ]);

    expect(first.runId).toBe(second.runId);
  });

  it("waits for a concurrent instance's initial append before returning", async () => {
    const store = new DelayedAppendStore();
    const { harness: firstHarness } = await createTestHarness({ store });
    const { harness: secondHarness } = await createTestHarness({ store, idStart: 10_000n });
    let resolved = false;
    const firstStart = firstHarness.startRun({
      goal: "Synthetic blocked append",
      idempotencyKey: "blocked-append-key",
    });

    await store.appendStarted;
    const duplicateStart = secondHarness
      .startRun({ goal: "Synthetic duplicate", idempotencyKey: "blocked-append-key" })
      .then((result) => {
        resolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    store.release();
    const [first, duplicate] = await Promise.all([firstStart, duplicateStart]);
    expect(duplicate.runId).toBe(first.runId);
  });

  it("takes over a stale orphan claim once after a pre-append process crash", async () => {
    const store = new InMemoryEventStore();
    const crashingStore = new OrphaningCrashStore(store, {
      crashAt: 1,
      mode: "before_commit",
    });
    const crashedHarness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: crashingStore,
        clock: new FakeClock(100_000),
        ids: idsStartingAt(9_000n),
        transientVault: true,
        model: fakeModel(),
      },
    });
    harnesses.push(crashedHarness);
    const request = { goal: "Synthetic orphaned request", idempotencyKey: "orphan-crash-key" };
    await expect(crashedHarness.startRun(request)).rejects.toMatchObject({
      code: "simulated_crash",
    });
    await crashedHarness.close();

    const createRestartHarness = async (idStart: bigint): Promise<Harness> => {
      const harness = await createHarness({
        config: HarnessConfigSchema.parse({}),
        overrides: {
          store,
          clock: new FakeClock(100_000),
          ids: idsStartingAt(idStart),
          transientVault: true,
          model: fakeModel(),
        },
      });
      harnesses.push(harness);
      return harness;
    };
    const firstRestart = await createRestartHarness(10_000n);
    const secondRestart = await createRestartHarness(20_000n);
    const [first, second] = await Promise.all([
      firstRestart.startRun(request),
      secondRestart.startRun(request),
    ]);
    expect(second.runId).toBe(first.runId);
    expect((await store.listRuns({ limit: 10 })).runs).toHaveLength(1);
  });

  it("retains a claim when the initial append commits before failing", async () => {
    const store = new InMemoryEventStore();
    const crashingStore = new CrashingEventStore(store, {
      crashAt: 1,
      mode: "after_commit",
    });
    const harness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: crashingStore,
        clock: new FakeClock(10_000),
        ids: idsStartingAt(30_000n),
        transientVault: true,
        model: fakeModel(),
      },
    });
    harnesses.push(harness);
    const request = { goal: "Synthetic committed request", idempotencyKey: "after-commit-key" };
    await expect(harness.startRun(request)).rejects.toMatchObject({ code: "simulated_crash" });

    const retry = await harness.startRun(request);
    expect(retry.runId).toBe(Id.parse("00000000000000000000030000"));
    expect((await store.listRuns({ limit: 10 })).runs).toHaveLength(1);
  });

  it("consults the store after a successful start leaves the in-flight cache", async () => {
    const { harness, store } = await createTestHarness();
    const request = { goal: "Synthetic retained request", idempotencyKey: "retention-key" };
    const first = await harness.startRun(request);
    await waitForRun(harness, first.runId, "completed");
    await store.deleteRun(Id.parse(first.runId));

    const second = await harness.startRun(request);
    expect(second.runId).not.toBe(first.runId);
  });

  it("deduplicates the same key across Harness instances sharing a store", async () => {
    const store = new InMemoryEventStore();
    const { harness: firstHarness } = await createTestHarness({ store });
    const { harness: secondHarness } = await createTestHarness({ store, idStart: 10_000n });

    const first = await firstHarness.startRun({
      goal: "Synthetic first request",
      idempotencyKey: "shared-instance-key",
    });
    const second = await secondHarness.startRun({
      goal: "Synthetic duplicate request",
      idempotencyKey: "shared-instance-key",
    });

    expect(second.runId).toBe(first.runId);
    expect((await store.listRuns({ limit: 10 })).runs).toHaveLength(1);
  });

  it("deduplicates the same key after reopening a persistent store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-sdk-idempotency-reopen-"));
    const path = join(directory, "events.sqlite");
    try {
      const firstHarness = await createHarness({
        config: HarnessConfigSchema.parse({}),
        overrides: {
          store: new SqliteEventStore(path),
          clock: new FakeClock(10_000),
          ids: new SequentialIdGenerator(),
          transientVault: true,
          model: fakeModel(),
        },
      });
      harnesses.push(firstHarness);
      const first = await firstHarness.startRun({
        goal: "Synthetic persistent request",
        idempotencyKey: "persistent-store-key",
      });
      await firstHarness.close();

      const secondHarness = await createHarness({
        config: HarnessConfigSchema.parse({}),
        overrides: {
          store: new SqliteEventStore(path),
          clock: new FakeClock(10_000),
          ids: {
            next: () => Id.parse("00000000000000000000010000"),
          },
          transientVault: true,
          model: fakeModel(),
        },
      });
      harnesses.push(secondHarness);
      const second = await secondHarness.startRun({
        goal: "Synthetic duplicate after reopen",
        idempotencyKey: "persistent-store-key",
      });

      expect(second.runId).toBe(first.runId);
      expect((await secondHarness.listRuns({ limit: 10 })).runs).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for the initial append before returning a run id", async () => {
    const store = new DelayedAppendStore();
    const { harness } = await createTestHarness({ store });
    let resolved = false;
    const start = harness.startRun({ goal: "Synthetic delayed append" }).then((result) => {
      resolved = true;
      return result;
    });

    await store.appendStarted;
    await Promise.resolve();
    expect(resolved).toBe(false);
    store.release();
    const { runId } = await start;

    await expect(harness.getRun(runId)).resolves.toMatchObject({ runId });
  });

  it("loads configuration from a path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-sdk-config-"));
    const configPath = join(directory, "config.yaml");
    try {
      await writeFile(configPath, "{}\n");
      const harness = await createHarness({
        configPath,
        overrides: {
          store: new InMemoryEventStore(),
          clock: new FakeClock(10_000),
          ids: new SequentialIdGenerator(),
          transientVault: true,
          model: fakeModel(),
        },
      });
      harnesses.push(harness);
      const started = await harness.startRun({ goal: "Synthetic config-path task" });
      await waitForRun(harness, started.runId, "completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await expect(createHarness({ configPath })).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("lists metadata pages and continues completed runs", async () => {
    const { harness } = await createTestHarness();
    const first = await harness.startRun({ goal: "Synthetic first task" });
    await waitForRun(harness, first.runId, "completed");
    const next = await harness.continueRun(first.runId, { goal: "Synthetic follow-up" });

    expect(next.status).toBe("completed");
    const page = await harness.listRuns({ status: "completed", limit: 1 });
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(() => ListRunsFilterSchema.parse({ status: "not-a-status" })).toThrow();
  });

  it("returns tokenized content only when explicitly requested", async () => {
    const { harness } = await createTestHarness();
    const started = await harness.startRun({ goal: "Contact alice@example.test" });
    await waitForRun(harness, started.runId, "completed");

    const content = await harness.getRunContent(started.runId, { reveal: false });
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("<EMAIL_1>");
    expect(serialized).not.toContain("alice@example.test");
    expect(() => GetRunContentOptionsSchema.parse({ reveal: true })).toThrow();
  });

  it("refuses content access when tokenization is disabled", async () => {
    const { harness } = await createTestHarness({ piiEnabled: false });
    const started = await harness.startRun({ goal: "Synthetic content" });
    await waitForRun(harness, started.runId, "completed");

    await expect(harness.getRunContent(started.runId, { reveal: false })).rejects.toMatchObject({
      code: "sdk_content_unavailable",
    });
  });

  it("watches safe events and accepts cooperative cancellation", async () => {
    const { harness } = await createTestHarness();
    const started = await harness.startRun({ goal: "Never expose this event canary" });
    await waitForRun(harness, started.runId, "completed");
    const events: unknown[] = [];
    for await (const event of harness.watch(started.runId, { fromSeq: 0 })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Never expose this event canary");
    expect(await harness.cancelRun(started.runId)).toBe("already_terminal");
    await expect(harness.getRun("invalid")).rejects.toThrow();
  });

  it("resolves approvals and resumes suspended runs", async () => {
    const { harness, store } = await createTestHarness({ approval: true });
    const started = await harness.startRun({ goal: "Synthetic approval task" });
    const suspended = await waitForRun(harness, started.runId, "suspended");
    const approvalId = suspended.pendingApprovals[0];
    expect(approvalId).toBeDefined();
    if (approvalId === undefined) {
      throw new Error("Expected one pending approval.");
    }

    const resolved = await harness.resolveApproval(approvalId, "approve", {
      principal: Principal.parse("cli.test"),
    });
    expect(resolved).toMatchObject({ runId: started.runId, approvalId, decision: "approve" });
    expect(
      (await readStoredEvents(store, started.runId)).find(
        (event) => event.type === "approval_resolved" && event.approvalId === approvalId,
      ),
    ).toMatchObject({ decidedBy: "human", approverId: "cli.test" });
    const resumed = await harness.resumeRun(started.runId);
    expect(resumed.status).toBe("completed");
  });

  it("validates answer requests and reports the unimplemented input contract safely", async () => {
    const { harness } = await createTestHarness();
    await expect(
      harness.answerInput("00000000000000000000000099", {
        action: Code.parse("answer"),
        content: { text: "synthetic" },
        principal: Code.parse("human.test"),
      }),
    ).rejects.toMatchObject({ code: "sdk_input_unavailable" });
    await expect(
      harness.answerInput("invalid", {
        action: Code.parse("answer"),
        principal: Code.parse("human.test"),
      }),
    ).rejects.toThrow("requestId");
  });

  it("stops subscriptions and rejects operations after close", async () => {
    const { harness } = await createTestHarness();
    const subscription = harness.watch("00000000000000000000000099");
    await harness.close();
    await expect(harness.listRuns()).rejects.toMatchObject({ code: "sdk_closed" });
    await expect(async () => {
      for await (const event of subscription) {
        expect(event).toBeUndefined();
      }
    }).rejects.toMatchObject({ code: "sdk_closed" });
    await expect(
      harness.answerInput("00000000000000000000000099", {
        action: Code.parse("answer"),
        principal: Code.parse("human.test"),
      }),
    ).rejects.toMatchObject({ code: "sdk_closed" });
    await harness.close();
  });
});
