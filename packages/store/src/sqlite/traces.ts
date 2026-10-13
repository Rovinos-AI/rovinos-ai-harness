// SPDX-License-Identifier: Apache-2.0
import { Id, TraceId } from "@harness/schemas";
import type Database from "better-sqlite3";
import { InvalidEventError } from "../errors.js";
import { sqliteStoreError } from "./outbox.js";

/** Finds run ids by a trace identifier through the SQLite event index. */
export function findRunsByTrace(
  query: Database.Statement<[TraceId], { run_id: string }>,
  traceId: TraceId,
): Promise<Id[]> {
  const parsedTraceId = TraceId.safeParse(traceId);
  if (!parsedTraceId.success) {
    return Promise.reject(new InvalidEventError([["traceId"]]));
  }
  try {
    return Promise.resolve(query.all(parsedTraceId.data).map(({ run_id }) => Id.parse(run_id)));
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}
