// SPDX-License-Identifier: Apache-2.0
import { Code, Event, FakeClock, Id, type Event as StoredEvent } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { buildApprovalPayload } from "./approval-payload.js";
import {
  sweepApprovals,
  type ApprovalExpiryResolution,
  type ApprovalSweepStore,
} from "./sweeper.js";

const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

interface StoreFixture {
  readonly store: FakeSweepStore;
  readonly runId: Id;
  readonly approvalId: Id;
}

class FakeSweepStore implements ApprovalSweepStore {
  private readonly runEvents = new Map<Id, StoredEvent[]>();
  private readonly notificationClaims = new Map<Id, Id>();
  private readonly resolutions = new Set<Id>();
  readonly resolutionMetadata: ApprovalExpiryResolution[] = [];

  constructor(
    readonly runId: Id,
    readonly approvalId: Id,
    events: StoredEvent[],
    private readonly now: () => number,
  ) {
    this.runEvents.set(runId, events);
  }

  listRuns(): Promise<{ runs: { runId: Id }[] }> {
    return Promise.resolve({ runs: [{ runId: this.runId }] });
  }

  read(runId: Id): AsyncIterable<StoredEvent> {
    const events = this.runEvents.get(runId) ?? [];
    return (async function* () {
      await Promise.resolve();
      yield* events;
    })();
  }

  claimApprovalNotification(approvalId: Id, runId: Id): Promise<boolean> {
    if (this.notificationClaims.has(approvalId)) {
      return Promise.resolve(false);
    }
    this.notificationClaims.set(approvalId, runId);
    return Promise.resolve(true);
  }

  releaseApprovalNotification(approvalId: Id, runId: Id): Promise<void> {
    if (this.notificationClaims.get(approvalId) === runId) {
      this.notificationClaims.delete(approvalId);
    }
    return Promise.resolve();
  }

  async resolveApproval(
    runId: Id,
    approvalId: Id,
    metadata: ApprovalExpiryResolution,
  ): Promise<Extract<StoredEvent, { type: "approval_resolved" }>> {
    await Promise.resolve();
    if (this.resolutions.has(approvalId)) {
      throw Object.assign(new Error("Already resolved"), { code: "approval_already_resolved" });
    }
    const events = this.runEvents.get(runId);
    const last = events?.at(-1);
    const request = events?.find(
      (event): event is Extract<StoredEvent, { type: "approval_requested" }> =>
        event.type === "approval_requested" && event.approvalId === approvalId,
    );
    if (events === undefined || last === undefined || request === undefined) {
      throw new Error("Missing synthetic approval.");
    }
    const resolution: Extract<StoredEvent, { type: "approval_resolved" }> = {
      runId,
      seq: events.length,
      ts: this.now(),
      v: 1,
      traceId: last.traceId,
      spanId: last.spanId,
      segmentId: last.segmentId,
      type: "approval_resolved",
      approvalId,
      decision: "deny",
      decidedBy: metadata.decidedBy,
      reason: metadata.reason,
      waitMs: Math.max(0, this.now() - request.ts),
    };
    Event.parse(resolution);
    this.resolutions.add(approvalId);
    this.resolutionMetadata.push(metadata);
    this.runEvents.set(runId, [...events, resolution]);
    return resolution;
  }
}

function createStoreFixture(options: {
  readonly now: number;
  readonly requestedAt?: number;
  readonly ttlMs?: number;
  readonly escalateAfterMs?: number;
}): StoreFixture {
  const runId = Id.parse("00000000000000000000000001");
  const callId = Id.parse("00000000000000000000000002");
  const approvalId = Id.parse("00000000000000000000000003");
  const requestedAt = options.requestedAt ?? 100;
  const payload = buildApprovalPayload({
    call: { callId, toolId: Code.parse("mail.send"), args: { to: "<EMAIL_1>" } },
    rule: {
      id: Code.parse("mail.ask"),
      reason: Code.parse("needs_human"),
      ...(options.ttlMs === undefined ? {} : { approvalTtlMs: options.ttlMs }),
    },
    now: requestedAt,
  });
  const base = {
    runId,
    ts: requestedAt,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
  };
  const events: StoredEvent[] = [
    Event.parse({
      ...base,
      seq: 0,
      type: "run_created",
      configHash: "b".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    }),
    Event.parse({
      ...base,
      seq: 1,
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "started",
    }),
    Event.parse({
      ...base,
      seq: 2,
      type: "tool_intent",
      callId,
      toolId: "mail.send",
      idempotent: false,
      policyDecision: "ask",
      policyEscalateAfterMs: options.escalateAfterMs,
      argsHash: "c".repeat(64),
      args: { to: "<EMAIL_1>" },
    }),
    Event.parse({
      ...base,
      seq: 3,
      type: "approval_requested",
      approvalId,
      callId,
      ...(options.ttlMs === undefined ? {} : { expiresAt: requestedAt + options.ttlMs }),
      payload,
    }),
    Event.parse({
      ...base,
      seq: 4,
      type: "run_status_changed",
      from: "running",
      to: "suspended",
      reason: "awaiting_approval",
    }),
  ];
  const clock = new FakeClock(options.now);
  return {
    store: new FakeSweepStore(runId, approvalId, events, () => clock.now()),
    runId,
    approvalId,
  };
}

describe("sweepApprovals", () => {
  it("denies an approval exactly at expiry before considering escalation", async () => {
    const fixture = createStoreFixture({ now: 110, ttlMs: 10, escalateAfterMs: 10 });
    const notifier = { notify: vi.fn(() => Promise.resolve()) };

    const result = await sweepApprovals({
      store: fixture.store,
      clock: new FakeClock(110),
      notifier,
    });

    expect(result).toEqual({ examined: 1, expired: 1, escalated: 0 });
    expect(fixture.store.resolutionMetadata).toEqual([
      { decidedBy: "expiry", reason: Code.parse("expired") },
    ]);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("sends each due escalation once across sequential sweeps", async () => {
    const fixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    const notifier = { notify: vi.fn(() => Promise.resolve()) };
    const options = { store: fixture.store, clock: new FakeClock(110), notifier };

    await expect(sweepApprovals(options)).resolves.toEqual({
      examined: 1,
      expired: 0,
      escalated: 1,
    });
    await expect(sweepApprovals(options)).resolves.toEqual({
      examined: 1,
      expired: 0,
      escalated: 0,
    });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith({
      runId: fixture.runId,
      approvalId: fixture.approvalId,
      toolId: Code.parse("mail.send"),
      ruleId: Code.parse("mail.ask"),
      ageMs: 10,
    });
  });

  it("tolerates concurrent expiry resolution and escalation sweeps", async () => {
    const expiryFixture = createStoreFixture({ now: 110, ttlMs: 10 });
    const expiryOptions = {
      store: expiryFixture.store,
      clock: new FakeClock(110),
      notifier: { notify: vi.fn(() => Promise.resolve()) },
    };
    const results = await Promise.all([
      sweepApprovals(expiryOptions),
      sweepApprovals(expiryOptions),
    ]);
    expect(results.reduce((count, result) => count + result.expired, 0)).toBe(1);

    const escalationFixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    const notifier = { notify: vi.fn(() => Promise.resolve()) };
    const escalationOptions = {
      store: escalationFixture.store,
      clock: new FakeClock(110),
      notifier,
    };
    const escalationResults = await Promise.all([
      sweepApprovals(escalationOptions),
      sweepApprovals(escalationOptions),
    ]);
    expect(escalationResults.reduce((count, result) => count + result.escalated, 0)).toBe(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("releases a notification claim when delivery fails", async () => {
    const fixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    await expect(
      sweepApprovals({
        store: fixture.store,
        clock: new FakeClock(110),
        notifier: { notify: () => Promise.reject(new Error("transport")) },
      }),
    ).rejects.toMatchObject({ code: "approval_sweep_failed" });

    const notifier = { notify: vi.fn(() => Promise.resolve()) };
    await expect(
      sweepApprovals({ store: fixture.store, clock: new FakeClock(110), notifier }),
    ).resolves.toMatchObject({ escalated: 1 });
  });

  it("skips unresolved approvals before their expiry or escalation thresholds", async () => {
    const fixture = createStoreFixture({ now: 105, ttlMs: 20, escalateAfterMs: 10 });
    const notifier = { notify: vi.fn(() => Promise.resolve()) };

    await expect(
      sweepApprovals({ store: fixture.store, clock: new FakeClock(105), notifier }),
    ).resolves.toEqual({ examined: 1, expired: 0, escalated: 0 });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("rejects an invalid clock value", async () => {
    const fixture = createStoreFixture({ now: 100 });
    await expect(
      sweepApprovals({
        store: fixture.store,
        clock: { now: () => Number.NaN },
        notifier: { notify: () => Promise.resolve() },
      }),
    ).rejects.toMatchObject({ code: "approval_sweep_failed" });
  });
});
