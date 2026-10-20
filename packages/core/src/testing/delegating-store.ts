// SPDX-License-Identifier: Apache-2.0
import type { EventStore } from "@harness/store";

/** Creates a distinct EventStore client that forwards every operation to the same backing store. */
export function delegatingStore(inner: EventStore): EventStore {
  return {
    append: (...args) => inner.append(...args),
    appendWithSnapshot: (...args) => inner.appendWithSnapshot(...args),
    appendWithUsage: (...args) => inner.appendWithUsage(...args),
    readUsageLedger: (...args) => inner.readUsageLedger(...args),
    claimRunExecution: (...args) => inner.claimRunExecution(...args),
    renewRunExecution: (...args) => inner.renewRunExecution(...args),
    releaseRunExecution: (...args) => inner.releaseRunExecution(...args),
    latestSnapshot: (...args) => inner.latestSnapshot(...args),
    retainedSnapshots: (...args) => inner.retainedSnapshots(...args),
    read: (...args) => inner.read(...args),
    watch: (...args) => inner.watch(...args),
    watchRuns: (...args) => inner.watchRuns(...args),
    head: (...args) => inner.head(...args),
    deleteRun: (...args) => inner.deleteRun(...args),
    listRuns: (...args) => inner.listRuns(...args),
    findRunsByTrace: (...args) => inner.findRunsByTrace(...args),
    fetchOutbox: (...args) => inner.fetchOutbox(...args),
    ackOutbox: (...args) => inner.ackOutbox(...args),
    claimApprovalNotification: (...args) => inner.claimApprovalNotification(...args),
    markApprovalNotificationSent: (...args) => inner.markApprovalNotificationSent(...args),
    releaseApprovalNotification: (...args) => inner.releaseApprovalNotification(...args),
    consumeConfirmationState: (...args) => inner.consumeConfirmationState(...args),
    claimIdempotencyKey: (...args) => inner.claimIdempotencyKey(...args),
    takeoverIdempotencyKey: (...args) => inner.takeoverIdempotencyKey(...args),
    releaseIdempotencyKey: (...args) => inner.releaseIdempotencyKey(...args),
    close: (...args) => inner.close(...args),
  };
}
