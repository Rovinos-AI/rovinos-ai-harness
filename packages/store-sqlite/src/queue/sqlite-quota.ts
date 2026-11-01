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
): (now: number) => (runId: string, canClaim: RunQueueClaimGuard) => boolean {
  let identityStatement: Database.Statement<[string], CandidateQuotaIdentityRow> | undefined;
  let activeIdentitiesStatement: Database.Statement<[number], QuotaIdentityRow> | undefined;
  return (now) => {
    identityStatement ??= db.prepare<[string], CandidateQuotaIdentityRow>(
      "SELECT e.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role, r.status FROM events AS e JOIN runs AS r ON r.run_id = e.run_id WHERE e.run_id = ? AND e.type = 'run_created' LIMIT 1",
    );
    activeIdentitiesStatement ??= db.prepare<[number], QuotaIdentityRow>(
      "SELECT r.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role FROM run_queue AS q INDEXED BY run_queue_active_lease_idx JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = q.run_id AND e.type = 'run_created' WHERE q.lease_owner IS NOT NULL AND q.lease_expires_at > ? UNION SELECT r.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role FROM run_queue AS q INDEXED BY run_queue_run_id_idx JOIN runs AS r ON r.run_id = q.run_id JOIN events AS e ON e.run_id = q.run_id AND e.type = 'run_created' WHERE r.status = 'running'",
    );
    const activeRuns = activeIdentitiesStatement
      .all(now)
      .map((active) => quotaIdentity(active.run_id, active));
    return (runId, canClaim) => {
      const row = identityStatement?.get(runId);
      const identity = quotaIdentity(runId, row);
      const alreadyRunning = row?.status === "running";
      const allowed = canClaim(
        identity,
        activeRuns.filter((active) => active.runId !== runId),
        alreadyRunning,
      );
      if (allowed && row?.status !== "running") {
        activeRuns.push(identity);
      }
      return allowed;
    };
  };
}
