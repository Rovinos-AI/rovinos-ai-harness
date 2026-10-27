// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import {
  IdempotencyKeyHashSchema,
  InvalidEventError,
  StoreUnavailableError,
  type IdempotencyKeyTakeoverOptions,
} from "@rovinos/store/adapter-internal";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresApprovalNotifications } from "./approval-notifications.js";
import {
  claimPostgresIdempotencyKey,
  releasePostgresIdempotencyKey,
  takeoverPostgresIdempotencyKey,
  type PostgresIdempotencyContext,
} from "./idempotency.js";
import { insertSnapshot } from "./snapshot.js";
import type { EncodedSnapshot } from "@rovinos/store/adapter-internal";

const runId = Id.parse("00000000000000000000000001");
const approvalId = Id.parse("00000000000000000000000002");
const keyHash = IdempotencyKeyHashSchema.parse("a".repeat(64));
const failedPool = {
  query: () => Promise.reject(new Error("synthetic database failure")),
} as unknown as Pool;

describe("Postgres auxiliary store error paths", () => {
  it("normalizes notification database failures across claim, mark, and release", async () => {
    const notifications = new PostgresApprovalNotifications(failedPool, () => Promise.resolve());
    await expect(notifications.claim(approvalId, runId, 10, 5)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await expect(notifications.markSent(approvalId, runId, 10, 20)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await expect(notifications.release(approvalId, runId, 10)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });

  it("validates idempotency claim times and normalizes query or empty-result failures", async () => {
    const context: PostgresIdempotencyContext = {
      pool: failedPool,
      initialize: () => Promise.resolve(),
      assertWritable: () => undefined,
    };
    await expect(claimPostgresIdempotencyKey(context, keyHash, runId, -1)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await expect(claimPostgresIdempotencyKey(context, keyHash, runId, 10)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    const emptyResultContext: PostgresIdempotencyContext = {
      ...context,
      pool: {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      } as unknown as Pool,
    };
    await expect(
      claimPostgresIdempotencyKey(emptyResultContext, keyHash, runId, 10),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect(releasePostgresIdempotencyKey(context, keyHash, runId)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    const takeover: IdempotencyKeyTakeoverOptions = {
      expectedRunId: runId,
      runId: approvalId,
      createdAt: 20,
      staleBefore: 10,
    };
    await expect(takeoverPostgresIdempotencyKey(context, keyHash, takeover)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });

  it("maps snapshot key collisions to invalid-event errors and preserves other driver failures", async () => {
    const snapshot: EncodedSnapshot = {
      snapshot_id: approvalId,
      run_id: runId,
      at_seq: 1,
      created_at: 10,
      meta_json: "{}",
      content_blob: "{}",
      key_id: null,
    };
    const duplicateClient = {
      query: () => Promise.reject({ code: "23505", table: "snapshots" }),
    } as unknown as PoolClient;
    await expect(insertSnapshot(duplicateClient, snapshot)).rejects.toBeInstanceOf(InvalidEventError);

    const failure = new Error("synthetic snapshot database failure");
    const failingClient = {
      query: vi.fn(() => Promise.reject(failure)),
    } as unknown as PoolClient;
    await expect(insertSnapshot(failingClient, snapshot)).rejects.toBe(failure);
  });
});
