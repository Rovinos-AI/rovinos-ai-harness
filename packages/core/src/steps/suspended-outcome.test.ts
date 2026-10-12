// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { suspendedOutcome } from "./suspended-outcome.js";

describe("suspendedOutcome", () => {
  it("rejects histories without a durable suspension event", () => {
    expect(() => suspendedOutcome([])).toThrow("Expected a suspension status event.");
  });
});
