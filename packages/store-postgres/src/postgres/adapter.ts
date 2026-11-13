// SPDX-License-Identifier: Apache-2.0
import type { Id, Event, NewEvent, TraceId } from "@rovinos/schemas";
import { Pool } from "pg";
import { z } from "zod";
import {
  JsonContentCodec,
  snapshotStoreOptionsSchema,
  systemClock,
  StoreReadOnlyError,
  type Clock,
  type ContentCodec,
  type EventStore,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
  type ListRunsOptions,
  type ReencryptBatchInput,
  type RunSummary,
  type StoreKeyRotation,
} from "@rovinos/store/adapter-internal";
import type { SpendReservationStore } from "@rovinos/store";
import { storeError } from "./helpers.js";
import { PostgresApprovalNotifications } from "./approval-notifications.js";
import { PostgresConfirmationStates } from "./confirmation-states.js";
import {
  claimPostgresIdempotencyKey,
  releasePostgresIdempotencyKey,
  takeoverPostgresIdempotencyKey,
  type PostgresIdempotencyContext,
} from "./idempotency.js";
import { initializePostgresStore } from "./initialize.js";
import { PostgresSubscriptions } from "./subscriptions.js";
import { countPostgresRowsByKey, reencryptPostgresBatch } from "./rotation.js";
import { PostgresEventWriter } from "./writer.js";
import { queryPostgresUsageLedger, readPostgresUsageLedger } from "./usage-ledger.js";
import { PostgresSpendReservation } from "./spend-reservation.js";
import { PostgresRunAccess } from "./run-access.js";

const connectionStringSchema = z
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  );
const optionsSchema = snapshotStoreOptionsSchema
  .extend({
    poolSize: z.number().int().min(1).max(100).default(10),
    schema: z
      .string()
      .regex(/^[a-z_]\w{0,62}$/i)
      .default("public"),
    skipMigrations: z.boolean().default(false),
  })
  .strict();

/** Options for a Postgres event-store connection. */
export type PostgresEventStoreOptions = z.input<typeof optionsSchema>;

/** Durable Postgres implementation of the append-only event store. */
export class PostgresEventStore implements EventStore, SpendReservationStore, StoreKeyRotation {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly snapshotKeep: number;
  private readonly clock: Clock;
  private readonly skipMigrations: boolean;
  private readonly approvalNotifications: PostgresApprovalNotifications;
  private readonly confirmationStates: PostgresConfirmationStates;
  private readonly writer: PostgresEventWriter;
  private readonly idempotencyContext: PostgresIdempotencyContext;
  private readonly subscriptions: PostgresSubscriptions;
  private readonly spendReservations: PostgresSpendReservation;
  private readonly runAccess: PostgresRunAccess;
  private initialized: Promise<void> | undefined;

  /**
   * Open a Postgres connection pool and initialize its event-store schema.
   *
   * @param connectionString Postgres connection URL.
   * @param options Pool size, schema selection, and validation-only read-only mode.
   * @param codec Codec used to store content separately from event metadata.
   * @param clock Clock supplying timestamps for sink-cursor updates.
   */
  constructor(
    connectionString: string,
    options: PostgresEventStoreOptions = {},
    codec: ContentCodec = new JsonContentCodec(),
    clock: Clock = systemClock,
  ) {
    const parsedConnectionString = connectionStringSchema.safeParse(connectionString);
    const parsedOptions = optionsSchema.safeParse(options);
    if (!parsedConnectionString.success || !parsedOptions.success) {
      throw new TypeError("Invalid Postgres event-store configuration");
    }
    this.pool = new Pool({
      connectionString: parsedConnectionString.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${parsedOptions.data.schema}"`,
    });
    this.pool.on("error", () => undefined);
    this.codec = codec;
    this.snapshotKeep = parsedOptions.data.snapshotKeep;
    this.clock = clock;
    this.skipMigrations = parsedOptions.data.skipMigrations;
    this.writer = new PostgresEventWriter({
      pool: this.pool,
      codec: this.codec,
      ensureInitialized: () => this.ensureInitialized(),
      assertWritable: () => {
        this.assertWritable();
      },
      snapshotKeep: this.snapshotKeep,
    });
    this.idempotencyContext = {
      pool: this.pool,
      initialize: () => this.ensureInitialized(),
      assertWritable: () => {
        this.assertWritable();
      },
    };
    this.approvalNotifications = new PostgresApprovalNotifications(this.pool, () =>
      this.ensureInitialized(),
    );
    this.confirmationStates = new PostgresConfirmationStates(this.pool, () =>
      this.ensureInitialized(),
    );
    this.subscriptions = new PostgresSubscriptions(
      this.pool,
      parsedConnectionString.data,
      parsedOptions.data.schema,
      () => this.ensureInitialized(),
    );
    this.spendReservations = new PostgresSpendReservation({
      pool: this.pool,
      codec: this.codec,
      ensureInitialized: () => this.ensureInitialized(),
      assertWritable: () => {
        this.assertWritable();
      },
      clock: this.clock,
    });
    this.runAccess = new PostgresRunAccess({
      pool: this.pool,
      codec: this.codec,
      clock: this.clock,
      ensureInitialized: () => this.ensureInitialized(),
      assertWritable: () => {
        this.assertWritable();
      },
      store: this,
      subscriptions: this.subscriptions,
    });
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize().catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private assertWritable(): void {
    if (this.skipMigrations) {
      throw new StoreReadOnlyError();
    }
  }

  private async initialize(): Promise<void> {
    await initializePostgresStore(this.pool, this.codec, this.clock, this.skipMigrations);
  }

  /** {@inheritDoc @rovinos/store!rotate.StoreKeyRotation.reencryptBatch} */
  reencryptBatch(input: ReencryptBatchInput): ReturnType<StoreKeyRotation["reencryptBatch"]> {
    this.assertWritable();
    return reencryptPostgresBatch(this.pool, this.codec, () => this.ensureInitialized(), input);
  }

  /** Count encrypted event and snapshot rows grouped by key identifier. */
  countRowsByKey(): ReturnType<StoreKeyRotation["countRowsByKey"]> {
    return countPostgresRowsByKey(this.pool, () => this.ensureInitialized());
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    return this.writer.append(runId, events, expectedSeq, leaseOwner);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    ...args: Parameters<EventStore["appendWithSnapshot"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, snapshot, leaseOwner] = args;
    return this.writer.appendWithSnapshot(runId, events, expectedSeq, snapshot, leaseOwner);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.appendWithUsage} */
  async appendWithUsage(
    ...args: Parameters<EventStore["appendWithUsage"]>
  ): Promise<{ nextSeq: number }> {
    return this.writer.appendWithUsage(...args);
  }

  /** Reserve quota headroom while atomically appending the model request. */
  reserveSpend(
    ...args: Parameters<SpendReservationStore["reserveSpend"]>
  ): ReturnType<SpendReservationStore["reserveSpend"]> {
    return this.spendReservations.reserveSpend(...args);
  }

  /** Mark a reserved request as dispatching before calling the provider. */
  markSpendDispatching(
    ...args: Parameters<SpendReservationStore["markSpendDispatching"]>
  ): ReturnType<SpendReservationStore["markSpendDispatching"]> {
    return this.spendReservations.markSpendDispatching(...args);
  }

  /** Release a reservation that has not been dispatched. */
  releaseSpend(
    ...args: Parameters<SpendReservationStore["releaseSpend"]>
  ): ReturnType<SpendReservationStore["releaseSpend"]> {
    return this.spendReservations.releaseSpend(...args);
  }

  /** Settle a dispatched reservation while atomically appending the model response. */
  settleSpend(
    ...args: Parameters<SpendReservationStore["settleSpend"]>
  ): ReturnType<SpendReservationStore["settleSpend"]> {
    return this.spendReservations.settleSpend(...args);
  }

  /** Mark an unconfirmed provider outcome as uncertain. */
  markSpendUncertain(
    ...args: Parameters<SpendReservationStore["markSpendUncertain"]>
  ): ReturnType<SpendReservationStore["markSpendUncertain"]> {
    return this.spendReservations.markSpendUncertain(...args);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.readUsageLedger} */
  async readUsageLedger(
    quotaId: Parameters<EventStore["readUsageLedger"]>[0],
    period: Parameters<EventStore["readUsageLedger"]>[1],
    periodStarts: readonly number[],
  ): ReturnType<EventStore["readUsageLedger"]> {
    return readPostgresUsageLedger({
      ensureInitialized: () => this.ensureInitialized(),
      query: (parsedQuotaId, parsedPeriod, requestedStarts) =>
        queryPostgresUsageLedger(this.pool, parsedQuotaId, parsedPeriod, requestedStarts),
      quotaId,
      period,
      periodStarts,
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.claimRunExecution} */
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return this.runAccess.claimRunExecution(runId, owner, now, leaseMs);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.renewRunExecution} */
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return this.runAccess.renewRunExecution(runId, owner, now, leaseMs);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.releaseRunExecution} */
  releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    return this.runAccess.releaseRunExecution(runId, owner);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.read} */
  read(runId: Id, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<Event> {
    return this.runAccess.read(runId, range);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.watch} */
  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<Event> {
    return this.runAccess.watch(runId, options);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.watchRuns} */
  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return this.runAccess.watchRuns(options);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.head} */
  head(runId: Id): Promise<number> {
    return this.runAccess.head(runId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.deleteRun} */
  deleteRun(runId: Id): Promise<number> {
    return this.runAccess.deleteRun(runId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.claimIdempotencyKey} */
  async claimIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    runId: Id,
    createdAt: number,
  ): Promise<Id> {
    return claimPostgresIdempotencyKey(this.idempotencyContext, keyHash, runId, createdAt);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.takeoverIdempotencyKey} */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: IdempotencyKeyTakeoverOptions,
  ): Promise<boolean> {
    this.assertWritable();
    return takeoverPostgresIdempotencyKey(this.idempotencyContext, keyHash, options);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.releaseIdempotencyKey} */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return releasePostgresIdempotencyKey(this.idempotencyContext, keyHash, runId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.latestSnapshot} */
  latestSnapshot(runId: Id): ReturnType<EventStore["latestSnapshot"]> {
    return this.runAccess.latestSnapshot(runId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.retainedSnapshots} */
  retainedSnapshots(runId: Id, limit: number): ReturnType<EventStore["retainedSnapshots"]> {
    return this.runAccess.retainedSnapshots(runId, limit);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.listRuns} */
  listRuns(opts: ListRunsOptions): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
    return this.runAccess.listRuns(opts);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.findRunsByTrace} */
  findRunsByTrace(traceId: TraceId): Promise<Id[]> {
    return this.runAccess.findRunsByTrace(traceId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.fetchOutbox} */
  fetchOutbox(
    ...args: Parameters<EventStore["fetchOutbox"]>
  ): ReturnType<EventStore["fetchOutbox"]> {
    return this.runAccess.fetchOutbox(...args);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.ackOutbox} */
  ackOutbox(...args: Parameters<EventStore["ackOutbox"]>): ReturnType<EventStore["ackOutbox"]> {
    return this.runAccess.ackOutbox(...args);
  }

  async claimApprovalNotification(
    ...args: Parameters<EventStore["claimApprovalNotification"]>
  ): ReturnType<EventStore["claimApprovalNotification"]> {
    this.assertWritable();
    return this.approvalNotifications.claim(...args);
  }

  async markApprovalNotificationSent(
    ...args: Parameters<EventStore["markApprovalNotificationSent"]>
  ): ReturnType<EventStore["markApprovalNotificationSent"]> {
    this.assertWritable();
    return this.approvalNotifications.markSent(...args);
  }

  async releaseApprovalNotification(
    ...args: Parameters<EventStore["releaseApprovalNotification"]>
  ): ReturnType<EventStore["releaseApprovalNotification"]> {
    this.assertWritable();
    return this.approvalNotifications.release(...args);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.consumeConfirmationState} */
  consumeConfirmationState(
    ...args: Parameters<EventStore["consumeConfirmationState"]>
  ): ReturnType<EventStore["consumeConfirmationState"]> {
    this.assertWritable();
    return this.confirmationStates.consume(...args);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.close} */
  async close(): Promise<void> {
    try {
      await this.subscriptions.close();
      await this.pool.end();
    } catch (error) {
      throw storeError(error);
    }
  }
}
