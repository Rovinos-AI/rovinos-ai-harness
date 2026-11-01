// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import type { RunQueueRunIdentity } from "@rovinos/store";
import {
  RunQueueRunIdentitySchema,
  parseQueueInput,
} from "@rovinos/store/adapter-internal";

interface QuotaIdentityRow {
  run_id: string;
  requested_by: unknown;
  role: unknown;
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

export function createQuotaClaimGuard(
  db: Database.Database,
): (runId: string, now: number, canClaim: (identity: RunQueueRunIdentity, activeRuns: readonly RunQueueRunIdentity[]) => boolean) => boolean {
  const identityStatement = db.prepare<[string], QuotaIdentityRow>(
    "SELECT run_id, json_extract(meta_json, '$.requestedBy') AS requested_by, json_extract(meta_json, '$.quotaRole') AS role FROM events WHERE run_id = ? AND type = 'run_created' LIMIT 1",
  );
  const activeIdentitiesStatement = db.prepare<[number], QuotaIdentityRow>(
    "SELECT DISTINCT r.run_id, json_extract(e.meta_json, '$.requestedBy') AS requested_by, json_extract(e.meta_json, '$.quotaRole') AS role FROM runs AS r JOIN events AS e ON e.run_id = r.run_id AND e.type = 'run_created' WHERE r.status = 'running' OR EXISTS (SELECT 1 FROM run_queue AS q WHERE q.run_id = r.run_id AND q.lease_owner IS NOT NULL AND q.lease_expires_at > ?)",
  );
  return (runId, now, canClaim) => {
    const identity = quotaIdentity(runId, identityStatement.get(runId));
    const activeRuns = activeIdentitiesStatement
      .all(now)
      .filter((active) => active.run_id !== identity.runId)
      .map((active) => quotaIdentity(active.run_id, active));
    return canClaim(identity, activeRuns);
  };
}
