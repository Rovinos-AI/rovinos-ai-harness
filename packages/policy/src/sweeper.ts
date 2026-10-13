// SPDX-License-Identifier: Apache-2.0
import {
  ApprovalSweepResultSchema,
  Code,
  HarnessError,
  type Id,
  type Event,
  type ApprovalSweepResult,
} from "@harness/schemas";
import { z } from "zod";
import { ApprovalPayloadSchema } from "./approval-payload.js";
import {
  ApprovalNotificationSchema,
  type ApprovalNotification,
  type Notifier,
} from "./notifier.js";

const sweepTimestampSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const APPROVAL_NOTIFICATION_LEASE_MS = 60_000;

/** Epoch-millisecond clock used for deterministic approval sweeps. */
export interface ApprovalSweepClock {
  /** Return the current epoch time in milliseconds. */
  now(): number;
}

/** Resolution metadata required when a pending approval expires. */
export interface ApprovalExpiryResolution {
  readonly decidedBy: "expiry";
  readonly reason: Code;
}

/** Minimal paginated suspended-run summary consumed by the sweeper. */
export interface ApprovalSweepRun {
  readonly runId: Id;
}

/**
 * Event-store claims provide durable idempotency; the injected resolver keeps run-event writes in
 * core and records them through RunRecorder without adding a policy-to-core dependency.
 */
export interface ApprovalSweepStore {
  /** List suspended runs using an opaque continuation cursor. */
  listRuns(options: {
    readonly status: "suspended";
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly runs: readonly ApprovalSweepRun[]; readonly nextCursor?: string }>;
  /** Read the validated event history for a run. */
  read(runId: Id): AsyncIterable<Event>;
  /** Atomically claim or reclaim an expired unsent notification for an approval. */
  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean>;
  /** Mark a successfully delivered notification as sent if its claim is current. */
  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean>;
  /** Release the notification claim when delivery fails. */
  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void>;
  /** Append an expiry resolution through the core approval resolver. */
  resolveApproval(
    runId: Id,
    approvalId: Id,
    metadata: ApprovalExpiryResolution,
  ): Promise<Extract<Event, { type: "approval_resolved" }>>;
}

interface PendingApproval {
  readonly request: Extract<Event, { type: "approval_requested" }>;
  readonly intent?: Extract<Event, { type: "tool_intent" }>;
}

class ApprovalSweepError extends HarnessError {
  readonly code = "approval_sweep_failed";

  constructor() {
    super("Approval sweep failed.");
    this.name = "ApprovalSweepError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function pendingForRun(store: ApprovalSweepStore, runId: Id): Promise<PendingApproval[]> {
  // 18.x periodic sweeping should replace full-history reads with an index of pending approvals.
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  const requests = new Map<Id, Extract<Event, { type: "approval_requested" }>>();
  const resolutions = new Set<Id>();
  const intents = new Map<Id, Extract<Event, { type: "tool_intent" }>>();
  let status: Extract<Event, { type: "run_status_changed" }>["to"] | undefined;
  for (const event of events) {
    if (event.type === "run_status_changed") {
      status = event.to;
    } else if (event.type === "tool_intent") {
      intents.set(event.callId, event);
    } else if (event.type === "approval_requested") {
      requests.set(event.approvalId, event);
    } else if (event.type === "approval_resolved") {
      resolutions.add(event.approvalId);
    }
  }
  if (status !== "suspended") {
    return [];
  }
  return [...requests.values()].flatMap((request) => {
    if (resolutions.has(request.approvalId)) {
      return [];
    }
    const intent = intents.get(request.callId);
    return [{ request, ...(intent === undefined ? {} : { intent }) }];
  });
}

async function suspendedRunIds(store: ApprovalSweepStore): Promise<Id[]> {
  const runIds: Id[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRuns({
      status: "suspended",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    runIds.push(...page.runs.map(({ runId }) => runId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runIds;
}

async function expireApproval(
  store: ApprovalSweepStore,
  runId: Id,
  approvalId: Id,
): Promise<boolean> {
  try {
    await store.resolveApproval(runId, approvalId, {
      decidedBy: "expiry",
      reason: Code.parse("expired"),
    });
    return true;
  } catch (error) {
    if (
      hasErrorCode(error, "approval_already_resolved") ||
      hasErrorCode(error, "approval_run_not_suspended") ||
      hasErrorCode(error, "approval_not_found")
    ) {
      return false;
    }
    throw error;
  }
}

async function notifyApproval(options: {
  readonly store: ApprovalSweepStore;
  readonly notifier: Notifier;
  readonly notification: ApprovalNotification;
  readonly claimedAt: number;
  readonly sentAt: () => number;
}): Promise<boolean> {
  const { store, notifier, notification, claimedAt, sentAt } = options;
  if (
    !(await store.claimApprovalNotification(
      notification.approvalId,
      notification.runId,
      claimedAt,
      APPROVAL_NOTIFICATION_LEASE_MS,
    ))
  ) {
    return false;
  }
  try {
    await notifier.notify(ApprovalNotificationSchema.parse(notification));
  } catch {
    try {
      await store.releaseApprovalNotification(
        notification.approvalId,
        notification.runId,
        claimedAt,
      );
    } catch {
      throw new ApprovalSweepError();
    }
    throw new ApprovalSweepError();
  }
  if (
    !(await store.markApprovalNotificationSent(
      notification.approvalId,
      notification.runId,
      claimedAt,
      sentAt(),
    ))
  ) {
    throw new ApprovalSweepError();
  }
  return true;
}

type ApprovalSweepOutcome = "expired" | "escalated" | "failed" | "skipped";

async function sweepPendingApproval(options: {
  readonly store: ApprovalSweepStore;
  readonly notifier: Notifier;
  readonly clock: ApprovalSweepClock;
  readonly runId: Id;
  readonly pending: PendingApproval;
  readonly now: number;
}): Promise<ApprovalSweepOutcome> {
  try {
    const { request, intent } = options.pending;
    if (request.expiresAt !== undefined && options.now >= request.expiresAt) {
      return (await expireApproval(options.store, options.runId, request.approvalId))
        ? "expired"
        : "skipped";
    }
    const escalateAfterMs = intent?.policyEscalateAfterMs;
    const payload = ApprovalPayloadSchema.safeParse(request.payload);
    if (
      escalateAfterMs === undefined ||
      options.now < request.ts ||
      options.now - request.ts < escalateAfterMs ||
      !payload.success
    ) {
      return "skipped";
    }
    const notification = ApprovalNotificationSchema.parse({
      runId: options.runId,
      approvalId: request.approvalId,
      toolId: payload.data.toolId,
      ruleId: payload.data.ruleId,
      ageMs: options.now - request.ts,
    });
    return (await notifyApproval({
      store: options.store,
      notifier: options.notifier,
      notification,
      claimedAt: options.now,
      sentAt: () => options.clock.now(),
    }))
      ? "escalated"
      : "skipped";
  } catch {
    return "failed";
  }
}

/**
 * Deny expired approvals and send each due escalation notification once.
 *
 * Expiry takes precedence over escalation at the same instant. The store port
 * delegates resolution to core so event recording continues through RunRecorder.
 *
 * @param options - Event store, clock, and metadata-only notification port.
 * @returns Counts of examined approvals, expiry resolutions, and notifications.
 */
export async function sweepApprovals(options: {
  readonly store: ApprovalSweepStore;
  readonly clock: ApprovalSweepClock;
  readonly notifier: Notifier;
}): Promise<ApprovalSweepResult> {
  const now = options.clock.now();
  if (!sweepTimestampSchema.safeParse(now).success) {
    throw new ApprovalSweepError();
  }
  const result = { examined: 0, expired: 0, escalated: 0, failed: 0 };
  for (const runId of await suspendedRunIds(options.store)) {
    for (const pending of await pendingForRun(options.store, runId)) {
      result.examined += 1;
      const outcome = await sweepPendingApproval({ ...options, runId, pending, now });
      if (outcome === "expired" || outcome === "escalated" || outcome === "failed") {
        result[outcome] += 1;
      }
    }
  }
  return ApprovalSweepResultSchema.parse(result);
}
