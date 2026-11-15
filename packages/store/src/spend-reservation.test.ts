// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { InMemoryEventStore, InMemorySpendReservationStore } from "./index.js";
import { isSpendReservationStore } from "./spend-reservation.js";

describe("isSpendReservationStore", () => {
  it("accepts stores with the complete transaction contract", () => {
    expect(isSpendReservationStore(new InMemorySpendReservationStore())).toBe(true);
  });

  it("rejects stores that explicitly disable reservations", () => {
    const store = Object.assign(new InMemorySpendReservationStore(), {
      supportsSpendReservations: false,
    });

    expect(isSpendReservationStore(store)).toBe(false);
  });

  it.each([
    "reserveSpend",
    "markSpendDispatching",
    "releaseSpend",
    "settleSpend",
    "markSpendUncertain",
  ] as const)("rejects a store without %s", (operation) => {
    const store = Object.assign(new InMemorySpendReservationStore(), {
      [operation]: undefined,
    });

    expect(isSpendReservationStore(store)).toBe(false);
  });

  it("rejects ordinary event stores without the reservation contract", () => {
    expect(isSpendReservationStore(new InMemoryEventStore())).toBe(false);
  });
});
