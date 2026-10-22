// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESUME_LEASE_MS, startLeaseRenewal } from "./resume-lease.js";

const runId = Id.parse("00000000000000000000000001");
const leaseOwner = Id.parse("00000000000000000000000002");

describe("resume lease renewal", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renews periodically without overlapping pending renewals", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    let completeRenewal: ((renewed: boolean) => void) | undefined;
    const renew = vi.spyOn(store, "renewRunExecution").mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRenewal = resolve;
        }),
    );
    const controller = new AbortController();
    const timer = startLeaseRenewal(
      { store, runId, clock: { now: () => 123 } },
      leaseOwner,
      controller,
    );

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renew).toHaveBeenCalledOnce();
      completeRenewal?.(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renew).toHaveBeenCalledTimes(2);
      expect(renew).toHaveBeenLastCalledWith(runId, leaseOwner, 123, RESUME_LEASE_MS);
      completeRenewal?.(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it("aborts when the lease is no longer owned", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    vi.spyOn(store, "renewRunExecution").mockResolvedValue(false);
    const controller = new AbortController();
    const timer = startLeaseRenewal(
      { store, runId, clock: { now: () => 123 } },
      leaseOwner,
      controller,
    );

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("resume_lease_lost");
    } finally {
      clearInterval(timer);
    }
  });

  it("aborts when lease renewal fails", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    vi.spyOn(store, "renewRunExecution").mockRejectedValue(new Error("store unavailable"));
    const controller = new AbortController();
    const timer = startLeaseRenewal(
      { store, runId, clock: { now: () => 123 } },
      leaseOwner,
      controller,
    );

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("resume_lease_lost");
    } finally {
      clearInterval(timer);
    }
  });
});
