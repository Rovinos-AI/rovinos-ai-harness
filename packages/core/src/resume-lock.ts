// SPDX-License-Identifier: Apache-2.0
import type { EventStore } from "@rovinos/store";
import type { Id } from "@rovinos/schemas";

const activeResumes = new WeakMap<EventStore, Set<Id>>();

/** Claims the in-process resume guard for a run and returns its release operation. */
export function claimResumeLock(
  store: EventStore,
  runId: Id,
  createConflictError: () => Error,
): () => void {
  let runs = activeResumes.get(store);
  if (runs === undefined) {
    runs = new Set();
    activeResumes.set(store, runs);
  }
  if (runs.has(runId)) {
    throw createConflictError();
  }
  runs.add(runId);
  return () => {
    runs.delete(runId);
    if (runs.size === 0) {
      activeResumes.delete(store);
    }
  };
}
