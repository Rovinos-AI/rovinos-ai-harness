// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from "pg";
import type { Id, NewEvent } from "@harness/schemas";
import {
  encodeSnapshot,
  validateSnapshotAppend,
  type ContentCodec,
  type EncodedSnapshot,
  type EventStore,
  type UsageLedgerDelta,
  parseUsageLedgerDeltas,
} from "@harness/store/adapter-internal";
import { appendTransaction, encodeEvents, storeError, type EncodedEvent } from "./helpers.js";

/** Dependencies used by a Postgres event writer. */
export interface PostgresEventWriterOptions {
  readonly pool: Pool;
  readonly codec: ContentCodec;
  readonly ensureInitialized: () => Promise<void>;
  readonly assertWritable: () => void;
  readonly snapshotKeep: number;
}

/** Append and snapshot operations for a Postgres event store. */
export class PostgresEventWriter {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly ensureInitialized: () => Promise<void>;
  private readonly assertWritable: () => void;
  private readonly snapshotKeep: number;

  constructor(options: PostgresEventWriterOptions) {
    this.pool = options.pool;
    this.codec = options.codec;
    this.ensureInitialized = options.ensureInitialized;
    this.assertWritable = options.assertWritable;
    this.snapshotKeep = options.snapshotKeep;
  }

  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    this.assertWritable();
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.appendEncoded({
      runId,
      encoded,
      expectedSeq,
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  async appendWithSnapshot(
    ...args: Parameters<EventStore["appendWithSnapshot"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, snapshot, leaseOwner] = args;
    this.assertWritable();
    const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
    const [encoded, encodedSnapshot] = await Promise.all([
      encodeEvents(this.codec, runId, events, expectedSeq),
      encodeSnapshot(this.codec, validatedSnapshot),
    ]);
    return this.appendEncoded({
      runId,
      encoded,
      expectedSeq,
      encodedSnapshot,
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  async appendWithUsage(
    ...args: Parameters<EventStore["appendWithUsage"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, options] = args;
    const { usageUpdates, leaseOwner } = options;
    this.assertWritable();
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.appendEncoded({
      runId,
      encoded,
      expectedSeq,
      usageUpdates: parseUsageLedgerDeltas(usageUpdates),
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  private async appendEncoded(options: {
    readonly runId: Id;
    readonly encoded: readonly EncodedEvent[];
    readonly expectedSeq: number;
    readonly encodedSnapshot?: EncodedSnapshot;
    readonly usageUpdates?: readonly UsageLedgerDelta[];
    readonly leaseOwner?: Id;
  }): Promise<{ nextSeq: number }> {
    const { runId, encoded, expectedSeq, encodedSnapshot, usageUpdates, leaseOwner } = options;
    await this.ensureInitialized();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storeError(error, expectedSeq);
    }
    try {
      return {
        nextSeq: await appendTransaction(client, {
          runId,
          encoded,
          expectedSeq,
          ...(encodedSnapshot === undefined ? {} : { encodedSnapshot }),
          ...(usageUpdates === undefined ? {} : { usageUpdates }),
          snapshotKeep: this.snapshotKeep,
          ...(leaseOwner === undefined ? {} : { leaseOwner }),
        }),
      };
    } finally {
      client.release();
    }
  }
}
