// SPDX-License-Identifier: Apache-2.0
import type { PoolClient } from "pg";
import { type RunQueueClaimOptions, type RunQueueRunIdentity } from "@rovinos/store";
import { RunQueueRunIdentitySchema, parseQueueInput } from "@rovinos/store/adapter-internal";
import { numberColumn, type QueueRow } from "./postgres-helpers.js";

interface CandidateIdentity {
  identity: RunQueueRunIdentity;
  alreadyRunning: boolean;
}

async function quotaIdentity(client: PoolClient, runId: string): Promise<CandidateIdentity> {
  const result = await client.query<{
    run_id: string;
    requested_by: string | null;
    role: string | null;
    status: string;
  }>(
    "SELECT e.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role, r.status FROM events AS e JOIN runs AS r ON r.run_id = e.run_id WHERE e.run_id = $1 AND e.type = 'run_created' LIMIT 1",
    [runId],
  );
  const row = result.rows[0];
  return {
    identity: parseQueueInput(RunQueueRunIdentitySchema, {
      runId,
      ...(row?.requested_by === null || row?.requested_by === undefined
        ? {}
        : { requestedBy: row.requested_by }),
      ...(row?.role === null || row?.role === undefined ? {} : { role: row.role }),
    }),
    alreadyRunning: row?.status === "running",
  };
}

async function activeQuotaIdentities(
  client: PoolClient,
  now: number,
): Promise<RunQueueRunIdentity[]> {
  const result = await client.query<{
    run_id: string;
    requested_by: string | null;
    role: string | null;
  }>(
    "SELECT r.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role FROM run_queue AS q JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE q.lease_owner IS NOT NULL AND q.lease_expires_at > $1 UNION SELECT r.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role FROM run_queue AS q JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE r.status = 'running'",
    [now],
  );
  return result.rows.map((row) =>
    parseQueueInput(RunQueueRunIdentitySchema, {
      runId: row.run_id,
      ...(row.requested_by === null ? {} : { requestedBy: row.requested_by }),
      ...(row.role === null ? {} : { role: row.role }),
    }),
  );
}

interface QuotaClaimParameters {
  client: PoolClient;
  worker: string;
  count: number;
  now: number;
  leaseExpiresAt: number;
  options: RunQueueClaimOptions;
}

/** Select, validate, and lease quota-aware Postgres claim candidates. */
export async function claimQuotaCandidates({
  client,
  worker,
  count,
  now,
  leaseExpiresAt,
  options,
}: QuotaClaimParameters): Promise<QueueRow[]> {
  const claimed: QueueRow[] = [];
  const skippedJobIds: string[] = [];
  const activeRuns = await activeQuotaIdentities(client, now);
  while (claimed.length < count) {
    const selected = await client.query<QueueRow>(
      "SELECT * FROM run_queue WHERE available_at <= $1 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $1) AND NOT (job_id = ANY($2::text[])) ORDER BY priority DESC, available_at, created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED",
      [now, skippedJobIds],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      break;
    }
    if (
      numberColumn(row.available_at) > now ||
      row.attempts >= row.max_attempts ||
      (row.lease_expires_at !== null && numberColumn(row.lease_expires_at) > now)
    ) {
      skippedJobIds.push(row.job_id);
      continue;
    }
    const candidate = await quotaIdentity(client, row.run_id);
    if (
      !options.canClaim(
        candidate.identity,
        activeRuns.filter((active) => active.runId !== candidate.identity.runId),
        candidate.alreadyRunning,
      )
    ) {
      skippedJobIds.push(row.job_id);
      continue;
    }
    const result = await client.query<QueueRow>(
      "UPDATE run_queue SET lease_owner = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3 WHERE job_id = $4 AND available_at <= $3 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $3) RETURNING *",
      [worker, leaseExpiresAt, now, row.job_id],
    );
    const updated = result.rows[0];
    if (updated === undefined) {
      skippedJobIds.push(row.job_id);
    } else {
      claimed.push(updated);
      if (!candidate.alreadyRunning) {
        activeRuns.push(candidate.identity);
      }
    }
  }
  return claimed;
}

/** Dead-letters expired queue rows whose attempts are exhausted. */
export async function deadLetterExpiredQueueJobs(client: PoolClient, now: number): Promise<void> {
  const expired = await client.query<QueueRow>(
    "SELECT * FROM run_queue WHERE attempts >= max_attempts AND lease_expires_at <= $1 ORDER BY lease_expires_at, job_id FOR UPDATE SKIP LOCKED",
    [now],
  );
  for (const row of expired.rows) {
    if (
      row.lease_expires_at === null ||
      numberColumn(row.lease_expires_at) > now ||
      row.attempts < row.max_attempts
    ) {
      continue;
    }
    await client.query(
      "INSERT INTO run_queue_dead (job_id, kind, run_id, priority, attempts, max_attempts, idempotency_key, last_error_code, created_at, dead_at) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'worker.lease_expired'), $9, $10)",
      [
        row.job_id,
        row.kind,
        row.run_id,
        row.priority,
        row.attempts,
        row.max_attempts,
        row.idempotency_key,
        row.last_error_code,
        numberColumn(row.created_at),
        now,
      ],
    );
    await client.query("DELETE FROM run_queue WHERE job_id = $1", [row.job_id]);
  }
}
