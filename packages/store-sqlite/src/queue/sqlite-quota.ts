// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { RunQueueRunIdentity, RunQueueClaimGuard } from "@rovinos/store";
import { RunQueueRunIdentitySchema, parseQueueInput } from "@rovinos/store/adapter-internal";

interface QuotaIdentityRow {
  run_id: string;
  requested_by: unknown;
  role: unknown;
}

interface CandidateQuotaIdentityRow extends QuotaIdentityRow {
  status: string;
}

function quotaIdentity(runId: string, row: QuotaIdentityRow | undefined): RunQueueRunIdentity {
  return parseQueueInput(RunQueueRunIdentitySchema, {
    runId,
    ...(row?.requested_by === null || row?.requested_by === undefined
      ? {}
      : { requestedBy: row.requested_by }),
    ...(row?.role === null || row?.role === undefined ? {} : { role: row.role }),
  });
}

/** Creates lazy statements so read-only queues can open without event tables. */
export function createQuotaClaimGuard(
  db: Database.Database,
): (
  now: number,
  runIds: readonly string[],
) => (
  runId: string,
  canClaim: RunQueueClaimGuard,
  onDeferred?: (identity: RunQueueRunIdentity) => void,
) => boolean {
  let activeIdentitiesStatement: Database.Statement<[number], QuotaIdentityRow> | undefined;
  return (now, runIds) => {
    const candidates = new Map<string, CandidateQuotaIdentityRow>();
    if (runIds.length > 0) {
      const placeholders = runIds.map(() => "?").join(", ");
      const identityStatement = db.prepare<unknown[], CandidateQuotaIdentityRow>(
        `SELECT e.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role, r.status FROM events AS e JOIN runs AS r ON r.run_id = e.run_id WHERE e.type = 'run_created' AND e.run_id IN (${placeholders})`,
      );
      for (const row of identityStatement.all(...runIds)) {
        candidates.set(row.run_id, row);
      }
    }
    activeIdentitiesStatement ??= db.prepare<[number], QuotaIdentityRow>(
      "SELECT r.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role FROM run_queue AS q INDEXED BY run_queue_active_lease_idx JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = q.run_id AND e.type = 'run_created' WHERE q.lease_owner IS NOT NULL AND q.lease_expires_at > ? UNION SELECT r.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role FROM runs AS r INDEXED BY runs_running_run_id_idx JOIN run_queue AS q INDEXED BY run_queue_run_id_idx ON q.run_id = r.run_id JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE r.status = 'running'",
    );
    const activeRuns = activeIdentitiesStatement
      .all(now)
      .map((active) => quotaIdentity(active.run_id, active));
    const markDeferred = db.prepare<[string]>(
      "UPDATE run_queue SET quota_rejection_reported = 1 WHERE run_id = ? AND quota_rejection_reported = 0",
    );
    return (runId, canClaim, onDeferred) => {
      const row = candidates.get(runId);
      const identity = quotaIdentity(runId, row);
      const alreadyRunning = row?.status === "running";
      const allowed = canClaim(
        identity,
        activeRuns.filter((active) => active.runId !== runId),
        alreadyRunning,
      );
      if (!allowed) {
        if (onDeferred !== undefined && markDeferred.run(runId).changes > 0) {
          onDeferred(identity);
        }
      } else if (!alreadyRunning) {
        activeRuns.push(identity);
      }
      return allowed;
    };
  };
}
