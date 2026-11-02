// SPDX-License-Identifier: Apache-2.0
import type { PoolClient } from "pg";
import { type RunQueueClaimOptions, type RunQueueRunIdentity } from "@rovinos/store";
import { RunQueueRunIdentitySchema, parseQueueInput } from "@rovinos/store/adapter-internal";
import { numberColumn, type QueueRow } from "./postgres-helpers.js";

interface QuotaCandidateRow extends QueueRow {
  requested_by: string | null;
  role: string | null;
  status: string;
}

function quotaIdentity(row: QuotaCandidateRow): CandidateIdentity {
  return {
    identity: parseQueueInput(RunQueueRunIdentitySchema, {
      runId: row.run_id,
      ...(row.requested_by === null ? {} : { requestedBy: row.requested_by }),
      ...(row.role === null ? {} : { role: row.role }),
    }),
    alreadyRunning: row.status === "running",
  };
}

interface CandidateIdentity {
  identity: RunQueueRunIdentity;
  alreadyRunning: boolean;
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
    "SELECT r.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role FROM run_queue AS q JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE q.lease_owner IS NOT NULL AND q.lease_expires_at > $1 UNION SELECT r.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role FROM runs AS r JOIN run_queue AS q ON q.run_id = r.run_id JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE r.status = 'running'",
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
  const activeRuns = await activeQuotaIdentities(client, now);
  const candidateLimit = Math.max(count, 100);
  const selected = await client.query<QuotaCandidateRow>(
    "SELECT q.*, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role, r.status FROM run_queue AS q JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = q.run_id AND e.type = 'run_created' WHERE q.available_at <= $1 AND q.attempts < q.max_attempts AND (q.lease_owner IS NULL OR q.lease_expires_at <= $1) ORDER BY q.quota_rejection_reported, q.priority DESC, q.available_at, q.created_at, q.job_id LIMIT $2 FOR UPDATE OF q SKIP LOCKED",
    [now, candidateLimit],
  );
  for (const row of selected.rows) {
    if (claimed.length >= count) {
      break;
    }
    if (
      numberColumn(row.available_at) > now ||
      row.attempts >= row.max_attempts ||
      (row.lease_expires_at !== null && numberColumn(row.lease_expires_at) > now)
    ) {
      continue;
    }
    const candidate = quotaIdentity(row);
    if (
      !options.canClaim(
        candidate.identity,
        activeRuns.filter((active) => active.runId !== candidate.identity.runId),
        candidate.alreadyRunning,
      )
    ) {
      const deferred = await client.query<{ job_id: string }>(
        "UPDATE run_queue SET quota_rejection_reported = TRUE WHERE job_id = $1 AND quota_rejection_reported = FALSE RETURNING job_id",
        [row.job_id],
      );
      if (deferred.rows.length > 0) {
        options.onDeferred?.(candidate.identity);
      }
      continue;
    }
    const result = await client.query<QueueRow>(
      "UPDATE run_queue SET lease_owner = $1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3 WHERE job_id = $4 AND available_at <= $3 AND attempts < max_attempts AND (lease_owner IS NULL OR lease_expires_at <= $3) RETURNING *",
      [worker, leaseExpiresAt, now, row.job_id],
    );
    const updated = result.rows[0];
    if (updated === undefined) {
      continue;
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
