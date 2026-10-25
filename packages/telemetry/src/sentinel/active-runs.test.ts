// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { ActiveRuns } from "./active-runs.js";

const firstRun = Id.parse("A".repeat(26));
const secondRun = Id.parse("B".repeat(26));

describe("ActiveRuns", () => {
  it("retains active runs and finished runs through the grace period", () => {
    let now = 10;
    const runs = new ActiveRuns({ graceMs: 5, now: () => now });
    runs.register(firstRun);
    runs.register(secondRun);
    runs.terminate(firstRun);

    expect(runs.runIds()).toEqual([firstRun, secondRun]);
    now = 15;
    expect(runs.runIds()).toEqual([secondRun]);
  });

  it("can reactivate a run and ignores termination for unknown IDs", () => {
    let now = 1;
    const runs = new ActiveRuns({ graceMs: 5, now: () => now });
    runs.terminate(firstRun);
    runs.register(firstRun);
    runs.terminate(firstRun);
    now = 7;

    expect(runs.runIds()).toEqual([]);
  });

  it("retains a run through an asynchronous operation and terminates it afterward", async () => {
    const runs = new ActiveRuns({ graceMs: 0 });

    await expect(
      runs.track(firstRun, () => {
        expect(runs.runIds()).toEqual([firstRun]);
        return Promise.resolve("completed");
      }),
    ).resolves.toBe("completed");
    expect(runs.runIds()).toEqual([]);
  });

  it("retains suspended operations and terminates them after a terminal result", async () => {
    const runs = new ActiveRuns({ graceMs: 0 });

    await runs.track(
      firstRun,
      () => Promise.resolve("suspended"),
      () => false,
    );
    expect(runs.runIds()).toEqual([firstRun]);

    await runs.track(
      firstRun,
      () => Promise.resolve("completed"),
      () => true,
    );
    expect(runs.runIds()).toEqual([]);
  });

  it("rejects invalid grace periods", () => {
    expect(() => new ActiveRuns({ graceMs: -1 })).toThrow();
  });
});
