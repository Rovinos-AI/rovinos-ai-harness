// SPDX-License-Identifier: Apache-2.0
import type { Code, Event, Id, NewEvent, RunStatus, Snapshot, TraceId } from "@rovinos/schemas";
import { Code as CodeSchema } from "@rovinos/schemas";
import { z } from "zod";
import { InvalidEventError } from "./errors.js";

/** Period boundaries used by cross-run quota accounting. */
export const UsageLedgerPeriodSchema = z.enum(["hour", "day", "month"]);
/** Window type associated with a ledger period. */
export type UsageLedgerPeriod = z.infer<typeof UsageLedgerPeriodSchema>;

/** Runtime schema for one incremental quota usage-ledger update. */
export const UsageLedgerDeltaSchema = z
  .object({
    quotaId: CodeSchema,
    period: UsageLedgerPeriodSchema,
    periodStart: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    runsStarted: z.number().int().nonnegative(),
    maxRunsStarted: z.number().int().positive().optional(),
  })
  .strict();

/** Increment applied to a quota usage-ledger period. */
export type UsageLedgerDelta = z.infer<typeof UsageLedgerDeltaSchema>;

/** Runtime schema for one persisted quota usage-ledger period. */
export const UsageLedgerRowSchema = z
  .object({
    quotaId: CodeSchema,
    period: UsageLedgerPeriodSchema,
    periodStart: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    runsStarted: z.number().int().nonnegative(),
  })
  .strict();

/** Persisted quota usage for one period. */
export type UsageLedgerRow = z.infer<typeof UsageLedgerRowSchema>;

/** Options for atomically appending events and applying quota usage. */
export interface UsageAppendOptions {
  /** Quota usage increments committed with the appended events. */
  readonly usageUpdates: readonly UsageLedgerDelta[];
  /** Optional execution lease owner. */
  readonly leaseOwner?: Id;
}

/** Validate and combine increments targeting the same quota period. */
export function parseUsageLedgerDeltas(input: unknown): UsageLedgerDelta[] {
  const parsed = UsageLedgerDeltaSchema.array().safeParse(input);
  if (!parsed.success) {
    throw new InvalidEventError(
      parsed.error.issues.map(({ path }) =>
        path.flatMap((part) =>
          typeof part === "string" || typeof part === "number" ? [part] : [],
        ),
      ),
    );
  }
  const combined = new Map<string, UsageLedgerDelta>();
  for (const delta of parsed.data) {
    const key = `${delta.quotaId}:${delta.period}:${String(delta.periodStart)}`;
    const previous = combined.get(key);
    const maxRunsStarted = minimumDefined(previous?.maxRunsStarted, delta.maxRunsStarted);
    combined.set(
      key,
      UsageLedgerDeltaSchema.parse({
        quotaId: delta.quotaId,
        period: delta.period,
        periodStart: delta.periodStart,
        costMicros: (previous?.costMicros ?? 0) + delta.costMicros,
        runsStarted: (previous?.runsStarted ?? 0) + delta.runsStarted,
        ...(maxRunsStarted === undefined ? {} : { maxRunsStarted }),
      }),
    );
  }

  function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) {
      return right;
    }
    if (right === undefined) {
      return left;
    }
    return Math.min(left, right);
  }
  return [...combined.values()];
}

/** Runtime schema for per-run checkpoint snapshot retention configuration. */
export const snapshotStoreOptionsSchema = z
  .object({ snapshotKeep: z.number().int().min(1).default(5) })
  .strict();

/** Snapshot retention options accepted by an EventStore. */
export type SnapshotStoreOptions = z.input<typeof snapshotStoreOptionsSchema>;

/** SQLite-specific snapshot and offline inspection options. */
export const sqliteStoreOptionsSchema = snapshotStoreOptionsSchema.extend({
  readOnly: z.boolean().default(false),
  pollIntervalMs: z.number().int().min(1).default(250),
});

/** SQLite adapter options for snapshot retention and cross-process watch polling. */
export type SqliteStoreOptions = z.input<typeof sqliteStoreOptionsSchema>;

/** SHA-256 digest used to persist an SDK idempotency key without storing the key itself. */
export const IdempotencyKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Inferred SHA-256 digest type for idempotency key storage. */
export type IdempotencyKeyHash = z.infer<typeof IdempotencyKeyHashSchema>;

/** Fields needed to atomically take over a stale idempotency-key claim. */
export interface IdempotencyKeyTakeoverOptions {
  /** Run id currently associated with the key. */
  readonly expectedRunId: Id;
  /** Candidate replacement run id. */
  readonly runId: Id;
  /** New claim time in epoch milliseconds. */
  readonly createdAt: number;
  /** Claims created at or before this timestamp may be replaced. */
  readonly staleBefore: number;
}

/** Source of epoch-millisecond timestamps used for store metadata. */
export interface Clock {
  /** Return the current epoch time in milliseconds. */
  now(): number;
}

/** System clock used when a store clock is not supplied. */
export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/** Summary of a run derived from its stored events. */
export interface RunSummary {
  /** Run identifier. */
  runId: Id;
  /** Timestamp of the run_created event, in epoch milliseconds. */
  createdAt: number;
  /** Latest status_changed target, or pending when no status change exists. */
  status: RunStatus;
  /** Sequence number of the last stored event. */
  lastSeq: number;
  /** Timestamp of the last stored event, in epoch milliseconds. */
  lastTs: number;
}

/** Options for listing runs. */
export interface ListRunsOptions {
  /** Restrict results to runs with this latest status. */
  status?: RunStatus;
  /** Restrict results to direct continuations of this run. */
  continuationOf?: Id;
  /** Maximum number of summaries to return. */
  limit: number;
  /** Opaque cursor returned by a previous call to listRuns. */
  cursor?: string;
}

/** Options for watching a run's event log. */
export interface WatchOptions {
  /** First sequence number to yield. */
  fromSeq: number;
  /** Stops the subscription when aborted. */
  signal: AbortSignal;
  /** Maximum stored events per read batch before the iterator re-reads from storage. */
  maxBuffered?: number;
}

/** Options for watching run summaries and status transitions. */
export interface WatchRunsOptions {
  /** Restrict emitted summaries to these current or newly entered statuses. */
  statuses?: readonly RunStatus[];
  /** Stops the subscription when aborted. */
  signal: AbortSignal;
}

/** Append-only event storage contract. */
export interface EventStore {
  /**
   * Validate and append events atomically, assigning consecutive sequence numbers.
   * @param runId Run identifier to append to.
   * @param events Events without their store-assigned sequence numbers.
   * @param expectedSeq Next sequence number the caller expects.
   * @returns The next free sequence number after the append.
   * @throws SeqConflictError when the stored head differs from expectedSeq.
   * @throws InvalidEventError when an event is invalid or belongs to another run.
   */
  append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }>;

  /**
   * Validate and append events and their checkpoint snapshot atomically.
   * @param runId Run identifier to append to.
   * @param events Events without their store-assigned sequence numbers.
   * @param expectedSeq Next sequence number the caller expects.
   * @param snapshot Snapshot associated with exactly one checkpoint_written event.
   * @returns The next free sequence number after the append.
   */
  appendWithSnapshot(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    snapshot: Snapshot,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }>;

  /**
   * Atomically append events and apply quota usage updates.
   * @param runId Run identifier to append to.
   * @param events Events without their store-assigned sequence numbers.
   * @param expectedSeq Next sequence number the caller expects.
   * @param usageUpdates Quota usage increments committed with the events.
   * @returns The next free sequence number after the append.
   */
  appendWithUsage(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    options: UsageAppendOptions,
  ): Promise<{ nextSeq: number }>;

  /** Read persisted usage for the requested quota periods. */
  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerPeriod,
    periodStarts: readonly number[],
  ): Promise<UsageLedgerRow[]>;

  /** Atomically claim an execution lease for one run until its expiry. */
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean>;

  /** Extend a currently owned execution lease, returning false after ownership is lost. */
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean>;

  /** Release a run execution lease only when the supplied owner is current. */
  releaseRunExecution(runId: Id, owner: Id): Promise<void>;

  /**
   * Retrieve the retained snapshot with the greatest atSeq for a run.
   * @param runId Run identifier to inspect.
   * @returns The latest snapshot, or undefined when none has been written.
   */
  latestSnapshot(runId: Id): Promise<Snapshot | undefined>;

  /**
   * Retrieve the most recent retained snapshots, bounded by the requested limit.
   * @param runId Run identifier to inspect.
   * @param limit Maximum number of retained snapshots to return.
   * @returns Snapshots ordered from newest to oldest.
   */
  retainedSnapshots(runId: Id, limit: number): Promise<Snapshot[]>;

  /**
   * Read events in sequence order. Both range endpoints are inclusive.
   * @param runId Run identifier to read.
   * @param range Optional inclusive sequence bounds.
   * @returns An async iterable of detached event copies.
   */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event>;

  /**
   * Follow a run's event log, yielding stored events before live events in sequence order.
   * The iterator ends after yielding a terminal status event or when the signal aborts.
   * @param runId Run identifier to watch.
   * @param options Starting sequence, abort signal, and optional notification backlog limit.
   * @returns An ordered stream of decoded events.
   */
  watch(runId: Id, options: WatchOptions): AsyncIterable<Event>;

  /**
   * Follow run summaries, yielding their current state and subsequent status transitions.
   * @param options Optional status filter and abort signal.
   * @returns A stream of run summaries.
   */
  watchRuns(options: WatchRunsOptions): AsyncIterable<RunSummary>;

  /**
   * Return the next free sequence number for a run.
   * @param runId Run identifier to inspect.
   * @returns The next free sequence number, or 0 for an unknown run.
   */
  head(runId: Id): Promise<number>;

  /**
   * Atomically remove a terminal run, its events, and its snapshots.
   * @param runId Run identifier to delete.
   * @returns The number of deleted events, or zero when the run is missing or not terminal.
   */
  deleteRun(runId: Id): Promise<number>;

  /**
   * List runs ordered by creation timestamp, newest first, with runId cursors.
   * @param opts Filters and pagination options.
   * @returns The selected run summaries and an optional cursor for the next page.
   */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }>;

  /**
   * Resolve a trace to all runs that contain it, ordered by first event appearance.
   * Replay uses this to resolve trace input and identify related runs.
   * @param traceId Trace identifier to search for.
   * @returns Matching run identifiers, or an empty array when none match.
   * @throws InvalidEventError when traceId is invalid.
   */
  findRunsByTrace(traceId: TraceId): Promise<Id[]>;

  /**
   * Fetch the next at-least-once batch of events for a sink.
   * @param sinkId Sink identifier with an independent persisted cursor.
   * @param limit Maximum number of events to return.
   * @returns Ordered events and the cursor after the last returned event, or the acked cursor if empty.
   */
  fetchOutbox(sinkId: Code, limit: number): Promise<{ events: Event[]; cursor: number }>;

  /**
   * Advance a sink's outbox cursor monotonically.
   * @param sinkId Sink identifier.
   * @param cursor Cursor returned by {@link EventStore.fetchOutbox}.
   */
  ackOutbox(sinkId: Code, cursor: number): Promise<void>;

  /**
   * Atomically claim an escalation notification or reclaim an expired unsent claim.
   * @param approvalId Approval whose notification is being claimed.
   * @param runId Run containing the approval, used to clean up with run retention.
   * @param claimedAt Claim time in epoch milliseconds.
   * @param leaseMs Duration before an unsent claim can be reclaimed.
   * @returns True only for the call that acquired the claim.
   */
  claimApprovalNotification(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    leaseMs: number,
  ): Promise<boolean>;

  /**
   * Mark a successfully delivered escalation notification as sent.
   * @param approvalId Approval whose notification was delivered.
   * @param runId Run containing the approval.
   * @param claimedAt Claim timestamp that identifies the current lease owner.
   * @param sentAt Successful delivery time in epoch milliseconds.
   * @returns Whether this claim was still current.
   */
  markApprovalNotificationSent(
    approvalId: Id,
    runId: Id,
    claimedAt: number,
    sentAt: number,
  ): Promise<boolean>;

  /**
   * Release an escalation claim after notification delivery fails.
   * @param approvalId Approval whose claim should be released.
   * @param runId Run containing the approval.
   * @param claimedAt Claim timestamp that identifies the current lease owner.
   */
  releaseApprovalNotification(approvalId: Id, runId: Id, claimedAt: number): Promise<void>;

  /**
   * Atomically consume a single-use request state, pruning expired entries first.
   * @param stateId Request-state identifier.
   * @param expiresAt Expiry timestamp in epoch milliseconds.
   * @param now Current timestamp in epoch milliseconds.
   * @returns True only when this call consumed an unused state.
   */
  consumeConfirmationState(stateId: string, expiresAt: number, now: number): Promise<boolean>;

  /**
   * Persist an idempotency hash or return the run id already associated with it.
   * @param keyHash SHA-256 digest of the caller's idempotency key.
   * @param runId Candidate run identifier for a new idempotency hash.
   * @param createdAt Claim time in epoch milliseconds.
   * @returns The candidate run id when inserted, otherwise the existing run id.
   */
  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id>;

  /**
   * Atomically replace an old claim when its run has no events.
   * @param keyHash SHA-256 digest of the caller's idempotency key.
   * @param options Expected owner, replacement id, and staleness cutoff.
   * @returns True only when this call replaced the expected claim.
   */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: IdempotencyKeyTakeoverOptions,
  ): Promise<boolean>;

  /**
   * Release a newly claimed key when its run failed before becoming durable.
   * @param keyHash SHA-256 digest of the caller's idempotency key.
   * @param runId Candidate run identifier that owns the claim.
   */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void>;

  /** Release resources held by the store. */
  close(): Promise<void>;
}
