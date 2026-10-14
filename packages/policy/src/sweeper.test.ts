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
  private readonly notificationClaims = new Map<
    Id,
    { readonly runId: Id; readonly claimedAt: number; readonly sentAt?: number }
  >();
  private readonly resolutions = new Set<Id>();
  readonly resolutionMetadata: ApprovalExpiryResolution[] = [];
  beforeResolve: ((runId: Id, approvalId: Id) => void) | undefined;
  failNextNotificationSentMark = false;

  constructor(
    readonly runId: Id,
    readonly approvalId: Id,
    events: StoredEvent[],
    private readonly now: () => number,
  ) {
    this.runEvents.set(runId, events);
  }

  listRuns(): Promise<{ runs: { runId: Id }[] }> {
    return Promise.resolve({ runs: [...this.runEvents.keys()].map((runId) => ({ runId })) });
  }

  addRunFrom(store: FakeSweepStore): void {
    const events = store.runEvents.get(store.runId);
    if (events !== undefined) {
      this.runEvents.set(store.runId, events);
    }
  }

  read(runId: Id): AsyncIterable<StoredEvent> {
    const events = this.runEvents.get(runId) ?? [];
    return (async function* () {
      await Promise.resolve();
      yield* events;
    })();
  }

  cancelRun(runId: Id): void {
    const events = this.runEvents.get(runId);
    const last = events?.at(-1);
    if (events === undefined || last === undefined) {
      return;
    }
    this.runEvents.set(runId, [
      ...events,
      Event.parse({
        runId,
        seq: events.length,
        ts: this.now(),
        v: 1,
        traceId: last.traceId,
        spanId: last.spanId,
        segmentId: last.segmentId,
        type: "run_status_changed",
        from: "suspended",
        to: "cancelled",
        reason: "cancelled",
      }),
    ]);
  }

  removeRun(runId: Id): void {
    this.runEvents.delete(runId);
  }

  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean> {
    const current = this.notificationClaims.get(approvalId);
    if (
      current !== undefined &&
      (current.runId !== runId ||
        current.sentAt !== undefined ||
        current.claimedAt > claimedAt - leaseMs)
    ) {
      return Promise.resolve(false);
    }
    this.notificationClaims.set(approvalId, { runId, claimedAt });
    return Promise.resolve(true);
  }

  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean> {
    if (this.failNextNotificationSentMark) {
      this.failNextNotificationSentMark = false;
      return Promise.reject(new Error("Synthetic sent marker failure."));
    }
    const current = this.notificationClaims.get(approvalId);
    if (
      current?.runId !== runId ||
      current.claimedAt !== claimedAt ||
      current.sentAt !== undefined
    ) {
      return Promise.resolve(false);
    }
    this.notificationClaims.set(approvalId, { runId, claimedAt, sentAt });
    return Promise.resolve(true);
  }

  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void> {
    const current = this.notificationClaims.get(approvalId);
    if (
      current?.runId === runId &&
      current.claimedAt === claimedAt &&
      current.sentAt === undefined
    ) {
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
    this.beforeResolve?.(runId, approvalId);
    if (this.resolutions.has(approvalId)) {
      throw Object.assign(new Error("Already resolved"), { code: "approval_already_resolved" });
    }
    const events = this.runEvents.get(runId);
    if (events === undefined) {
      throw Object.assign(new Error("Run was deleted."), { code: "approval_not_found" });
    }
    const last = events.at(-1);
    const request = events.find(
      (event): event is Extract<StoredEvent, { type: "approval_requested" }> =>
        event.type === "approval_requested" && event.approvalId === approvalId,
    );
    if (last === undefined || request === undefined) {
      throw Object.assign(new Error("Approval was deleted."), { code: "approval_not_found" });
    }
    const status = [...events].reverse().find((event) => event.type === "run_status_changed");
    if (status?.type !== "run_status_changed" || status.to !== "suspended") {
      throw Object.assign(new Error("Run is no longer suspended."), {
        code: "approval_run_not_suspended",
      });
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
  readonly idOffset?: number;
}): StoreFixture {
  const id = (offset: number) =>
    Id.parse(String((options.idOffset ?? 0) + offset).padStart(26, "0"));
  const runId = id(1);
  const callId = id(2);
  const approvalId = id(3);
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

    expect(result).toEqual({ examined: 1, expired: 1, escalated: 0, failed: 0 });
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
      failed: 0,
    });
    await expect(sweepApprovals(options)).resolves.toEqual({
      examined: 1,
      expired: 0,
      escalated: 0,
      failed: 0,
    });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith({
      runId: fixture.runId,
      approvalId: fixture.approvalId,
      idempotencyKey: fixture.approvalId,
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

  it("releases failed notification claims and counts the failure", async () => {
    const fixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    await expect(
      sweepApprovals({
        store: fixture.store,
        clock: new FakeClock(110),
        notifier: { notify: () => Promise.reject(new Error("transport")) },
      }),
    ).resolves.toEqual({ examined: 1, expired: 0, escalated: 0, failed: 1 });

    const notifier = { notify: vi.fn(() => Promise.resolve()) };
    await expect(
      sweepApprovals({ store: fixture.store, clock: new FakeClock(110), notifier }),
    ).resolves.toMatchObject({ escalated: 1, failed: 0 });
  });

  it("reclaims an abandoned claim after the delivery lease expires", async () => {
    const fixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    const clock = new FakeClock(110);
    const leaseMs = 60_000;
    await expect(
      fixture.store.claimApprovalNotification(
        fixture.approvalId,
        fixture.runId,
        clock.now(),
        leaseMs,
      ),
    ).resolves.toBe(true);
    clock.advance(leaseMs);
    const notifier = { notify: vi.fn(() => Promise.resolve()) };

    await expect(sweepApprovals({ store: fixture.store, clock, notifier })).resolves.toEqual({
      examined: 1,
      expired: 0,
      escalated: 1,
      failed: 0,
    });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("redelivers after a sent-marker failure with the same idempotency key", async () => {
    const fixture = createStoreFixture({ now: 110, escalateAfterMs: 10 });
    fixture.store.failNextNotificationSentMark = true;
    const clock = new FakeClock(110);
    const delivered: { readonly approvalId: Id; readonly idempotencyKey: Id }[] = [];
    const notifier = {
      notify: vi.fn((notification: { approvalId: Id; idempotencyKey: Id }) => {
        delivered.push({
          approvalId: notification.approvalId,
          idempotencyKey: notification.idempotencyKey,
        });
        return Promise.resolve();
      }),
    };

    await expect(
      sweepApprovals({ store: fixture.store, clock, notifier }),
    ).resolves.toMatchObject({ failed: 1, escalated: 0 });

    clock.advance(60_000);
    await expect(
      sweepApprovals({ store: fixture.store, clock, notifier }),
    ).resolves.toMatchObject({ failed: 0, escalated: 1 });

    expect(delivered).toEqual([
      { approvalId: fixture.approvalId, idempotencyKey: fixture.approvalId },
      { approvalId: fixture.approvalId, idempotencyKey: fixture.approvalId },
    ]);
  });

  it.each([
    ["cancelled", "approval_run_not_suspended"],
    ["deleted", "approval_not_found"],
  ])("ignores a run %s after the pending snapshot", async (_name, code) => {
    const fixture = createStoreFixture({ now: 110, ttlMs: 10 });
    const later = createStoreFixture({ now: 110, ttlMs: 10, idOffset: 10 });
    fixture.store.addRunFrom(later.store);
    fixture.store.beforeResolve = (runId) => {
      if (runId === fixture.runId) {
        if (code === "approval_not_found") {
          fixture.store.removeRun(runId);
        } else {
          fixture.store.cancelRun(runId);
        }
      }
    };

    await expect(
      sweepApprovals({
        store: fixture.store,
        clock: new FakeClock(110),
        notifier: { notify: vi.fn(() => Promise.resolve()) },
      }),
    ).resolves.toEqual({ examined: 2, expired: 1, escalated: 0, failed: 0 });
  });

  it("counts unexpected per-approval failures and continues with later approvals", async () => {
    const fixture = createStoreFixture({ now: 110, ttlMs: 10 });
    const later = createStoreFixture({ now: 110, ttlMs: 10, idOffset: 10 });
    fixture.store.addRunFrom(later.store);
    fixture.store.beforeResolve = (runId) => {
      if (runId === fixture.runId) {
        throw Object.assign(new Error("Synthetic per-approval failure"), {
          code: "synthetic_failure",
        });
      }
    };

    await expect(
      sweepApprovals({
        store: fixture.store,
        clock: new FakeClock(110),
        notifier: { notify: vi.fn(() => Promise.resolve()) },
      }),
    ).resolves.toEqual({ examined: 2, expired: 1, escalated: 0, failed: 1 });
  });

  it("skips unresolved approvals before their expiry or escalation thresholds", async () => {
    const fixture = createStoreFixture({ now: 105, ttlMs: 20, escalateAfterMs: 10 });
    const notifier = { notify: vi.fn(() => Promise.resolve()) };

    await expect(
      sweepApprovals({ store: fixture.store, clock: new FakeClock(105), notifier }),
    ).resolves.toEqual({ examined: 1, expired: 0, escalated: 0, failed: 0 });
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
