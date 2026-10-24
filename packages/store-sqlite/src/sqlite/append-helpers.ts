// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { RunStatus, type Event as StoredEvent, type Id } from "@rovinos/schemas";
import {
  InvalidEventError,
  RunExecutionLeaseLostError,
  type RunSummary,
} from "@rovinos/store/adapter-internal";

/** Verifies that an append still owns the run's execution lease. */
export function assertExecutionLease(
  db: Database.Database,
  runId: Id,
  leaseOwner: Id | undefined,
): void {
  if (leaseOwner === undefined) {
    return;
  }
  const lease = db
    .prepare<[Id], { owner_id: Id }>("SELECT owner_id FROM run_execution_leases WHERE run_id = ?")
    .get(runId);
  if (lease?.owner_id !== leaseOwner) {
    throw new RunExecutionLeaseLostError();
  }
}

/** Validates and folds the run status after an event append. */
export function nextRunStatus(
  currentStatus: string | undefined,
  events: readonly StoredEvent[],
): RunSummary["status"] {
  const parsedStatus = RunStatus.safeParse(currentStatus ?? "pending");
  if (!parsedStatus.success) {
    throw new InvalidEventError([["status"]]);
  }
  let status = parsedStatus.data;
  for (const event of events) {
    if (event.type === "run_status_changed") {
      status = event.to;
    }
  }
  return status;
}
