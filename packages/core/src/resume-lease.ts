// SPDX-License-Identifier: Apache-2.0
import type { Id } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { Clock } from "./recorder.js";

export const RESUME_LEASE_MS = 30_000;
const RESUME_LEASE_RENEW_MS = 10_000;

/** Renews the durable execution lease until the controller is aborted. */
export function startLeaseRenewal(
  options: { readonly store: EventStore; readonly runId: Id; readonly clock: Clock },
  leaseOwner: Id,
  leaseController: AbortController,
): ReturnType<typeof setInterval> {
  let renewalPending = false;
  return setInterval(() => {
    if (renewalPending) {
      return;
    }
    renewalPending = true;
    void options.store
      .renewRunExecution(options.runId, leaseOwner, options.clock.now(), RESUME_LEASE_MS)
      .then((renewed) => {
        if (!renewed) {
          leaseController.abort("resume_lease_lost");
        }
      })
      .catch(() => {
        leaseController.abort("resume_lease_lost");
      })
      .finally(() => {
        renewalPending = false;
      });
  }, RESUME_LEASE_RENEW_MS);
}
