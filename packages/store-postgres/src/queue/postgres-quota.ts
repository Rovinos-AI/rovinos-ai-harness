// SPDX-License-Identifier: Apache-2.0
import type { PoolClient } from "pg";
import {
  type RunQueueClaimOptions,
  type RunQueueRunIdentity,
} from "@rovinos/store";
import { RunQueueRunIdentitySchema, parseQueueInput } from "@rovinos/store/adapter-internal";
import { numberColumn, type QueueRow } from "./postgres-helpers.js";

export async function quotaIdentity(
  client: PoolClient,
  runId: string,
): Promise<RunQueueRunIdentity> {
  const result = await client.query<{
    run_id: string;
    requested_by: string | null;
    role: string | null;
  }>(
    "SELECT run_id, meta ->> 'requestedBy' AS requested_by, meta ->> 'quotaRole' AS role FROM events WHERE run_id = $1 AND type = 'run_created' LIMIT 1",
    [runId],
  );
  const row = result.rows[0];
  return parseQueueInput(RunQueueRunIdentitySchema, {
    runId,
    ...(row?.requested_by === null || row?.requested_by === undefined
      ? {}
      : { requestedBy: row.requested_by }),
    ...(row?.role === null || row?.role === undefined ? {} : { role: row.role }),
  });
}

async function activeQuotaIdentities(
  client: PoolClient,
  now: number,
  excludingRunId: string,
): Promise<RunQueueRunIdentity[]> {
  const result = await client.query<{
    run_id: string;
    requested_by: string | null;
    role: string | null;
  }>(
    "SELECT DISTINCT r.run_id, e.meta ->> 'requestedBy' AS requested_by, e.meta ->> 'quotaRole' AS role FROM runs AS r JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE r.status = 'running' OR EXISTS (SELECT 1 FROM run_queue AS q WHERE q.run_id = r.run_id AND q.lease_owner IS NOT NULL AND q.lease_expires_at > $1)",
    [now],
  );
  return result.rows
    .filter((row) => row.run_id !== excludingRunId)
    .map((row) =>
      parseQueueInput(RunQueueRunIdentitySchema, {
        runId: row.run_id,
        ...(row.requested_by === null ? {} : { requestedBy: row.requested_by }),
        ...(row.role === null ? {} : { role: row.role }),
      }),
    );
}

export async function claimQuotaCandidates(
  client: PoolClient,
  worker: string,
  count: number,
  now: number,
  leaseExpiresAt: number,
  options: RunQueueClaimOptions,
): Promise<QueueRow[]> {
  const claimed: QueueRow[] = [];
  const skippedJobIds: string[] = [];
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
    const identity = await quotaIdentity(client, row.run_id);
    const activeRuns = await activeQuotaIdentities(client, now, row.run_id);
    if (!options.canClaim(identity, activeRuns)) {
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
    }
  }
  return claimed;
}
