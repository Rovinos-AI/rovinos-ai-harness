// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countSentinelScopeReduced } from "../metrics.js";
import { ActiveRuns } from "./active-runs.js";
import { assertSentinelGate, SentinelGate, SentinelRequiredError } from "./gate.js";
import { TripQueue } from "./trips.js";
import { VaultRunView, type VaultRunReader } from "./run-values.js";
import { fitsPatternSizeLimit } from "./variants.js";

vi.mock("../metrics.js", () => ({
  countSentinelScopeReduced: vi.fn(),
}));

const firstRun = Id.parse("A".repeat(26));
const secondRun = Id.parse("B".repeat(26));

function createReader(valuesByRun: Map<string, string[]>): VaultRunReader {
  return {
    version: (runId) => Promise.resolve(valuesByRun.get(runId)?.length ?? 0),
    listRawValueEntries: (runId) =>
      Promise.resolve(
        (valuesByRun.get(runId) ?? []).map((rawValue) => ({
          entityType: Code.parse("email"),
          rawValue,
        })),
      ),
  };
}

function makeTripQueue(): TripQueue {
  return new TripQueue({ emit: vi.fn(), enabled: () => true });
}

function matcherFor(values: readonly string[]) {
  return {
    findAll: (text: string) =>
      values.flatMap((value, patternIndex) => (text.includes(value) ? [{ patternIndex }] : [])),
  };
}

describe("SentinelGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a run-scoped matcher and enqueues metadata-only trips on a hit", async () => {
    const tripQueue = makeTripQueue();
    const matcherForValues = vi.fn(matcherFor);
    const gate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-raw-value"]]]))),
      new ActiveRuns(),
      { matcherForValues, tripQueue },
    );

    await expect(gate.check({ runId: firstRun, text: "payload known-raw-value" })).resolves.toEqual(
      {
        ok: false,
        reason: "hit",
      },
    );
    expect(matcherForValues).toHaveBeenCalledWith(["known-raw-value"]);
    expect(tripQueue.drainForRun(firstRun)).toEqual([
      { runId: firstRun, entities: [{ type: "email", count: 1 }] },
    ]);
    expect(tripQueue.drainForRun(firstRun)).toEqual([]);
  });

  it("catches a child canary using the shared root vault scope", async () => {
    const childRun = Id.parse("C".repeat(26));
    const rootCanary = "root-scope-private-value";
    const reader = createReader(new Map([[firstRun, [rootCanary]]]));
    const view = new VaultRunView(reader, {}, () => firstRun);
    const gate = new SentinelGate(view, new ActiveRuns(), { tripQueue: makeTripQueue() });

    await expect(
      gate.check({ runId: childRun, text: `child span ${rootCanary}` }),
    ).resolves.toEqual({ ok: false, reason: "hit" });
  });

  it("uses and caches a combined matcher for active and grace-period runs", async () => {
    const runs = new ActiveRuns({ now: () => 1 });
    runs.register(firstRun);
    runs.register(secondRun);
    runs.terminate(firstRun);
    const matcherForValues = vi.fn(matcherFor);
    const tripQueue = makeTripQueue();
    const gate = new SentinelGate(
      new VaultRunView(
        createReader(
          new Map([
            [firstRun, ["first-run-value"]],
            [secondRun, ["second-run-value"]],
          ]),
        ),
      ),
      runs,
      { matcherForValues, tripQueue },
    );

    await expect(gate.check({ text: "second-run-value" })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
    await expect(gate.check({ text: "safe" })).resolves.toEqual({ ok: true });
    expect(matcherForValues).toHaveBeenCalledExactlyOnceWith([
      "first-run-value",
      "second-run-value",
    ]);
  });

  it("switches to per-run matchers when the combined value limit is exceeded", async () => {
    const runs = new ActiveRuns();
    runs.register(firstRun);
    runs.register(secondRun);
    const matcherForValues = vi.fn(matcherFor);
    const tripQueue = makeTripQueue();
    const gate = new SentinelGate(
      new VaultRunView(
        createReader(
          new Map([
            [firstRun, ["first-value"]],
            [secondRun, ["second-value"]],
          ]),
        ),
      ),
      runs,
      { maxCombinedValues: 1, matcherForValues, tripQueue },
    );

    await expect(gate.check({ text: "second-value" })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
    await expect(gate.check({ text: "safe" })).resolves.toEqual({ ok: true });
    expect(countSentinelScopeReduced).toHaveBeenCalledOnce();
    expect(matcherForValues).toHaveBeenCalledTimes(2);
  });

  it("switches to per-run matchers when expanded patterns exceed the size limit", async () => {
    const runs = new ActiveRuns();
    runs.register(firstRun);
    runs.register(secondRun);
    const candidateValues = Array.from(
      { length: 8_000 },
      (_, index) => `sentinel-${index.toString(36).padStart(6, "0")}-1234567`,
    );
    let lowerBound = 0;
    let upperBound = candidateValues.length;
    while (lowerBound < upperBound) {
      const middle = Math.ceil((lowerBound + upperBound) / 2);
      if (fitsPatternSizeLimit(candidateValues.slice(0, middle))) {
        lowerBound = middle;
      } else {
        upperBound = middle - 1;
      }
    }
    const underLimitCount = lowerBound;
    const firstRunValues = candidateValues.slice(0, underLimitCount);
    const secondRunValues = candidateValues.slice(underLimitCount, underLimitCount + 1);
    expect(secondRunValues).toHaveLength(1);
    expect(fitsPatternSizeLimit(firstRunValues)).toBe(true);
    expect(fitsPatternSizeLimit(secondRunValues)).toBe(true);
    expect(fitsPatternSizeLimit([...firstRunValues, ...secondRunValues])).toBe(false);

    const matcherForValues = vi.fn(matcherFor);
    const gate = new SentinelGate(
      new VaultRunView(
        createReader(
          new Map([
            [firstRun, firstRunValues],
            [secondRun, secondRunValues],
          ]),
        ),
      ),
      runs,
      {
        matcherForValues,
        tripQueue: makeTripQueue(),
        maxPrepareMs: 10_000,
        maxScanMs: 10_000,
      },
    );

    await expect(gate.check({ text: secondRunValues.at(-1) ?? "" })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
    expect(matcherForValues).toHaveBeenCalledTimes(2);
    expect(matcherForValues).toHaveBeenNthCalledWith(1, firstRunValues);
    expect(matcherForValues).toHaveBeenNthCalledWith(2, secondRunValues);
    expect(countSentinelScopeReduced).toHaveBeenCalledOnce();
  });

  it("refreshes the matcher when a run's vault version changes", async () => {
    let values = ["first-value"];
    let version = 1;
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValueEntries: () =>
        Promise.resolve(values.map((rawValue) => ({ entityType: Code.parse("email"), rawValue }))),
    };
    const gate = new SentinelGate(new VaultRunView(reader), new ActiveRuns(), {
      tripQueue: makeTripQueue(),
    });

    await expect(gate.check({ runId: firstRun, text: "new-value" })).resolves.toEqual({ ok: true });
    values = ["first-value", "new-value"];
    version = 2;
    await expect(gate.check({ runId: firstRun, text: "new-value" })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
  });

  it("fails closed on matcher errors and scan timeouts", async () => {
    const values = new VaultRunView(createReader(new Map([[firstRun, ["known-value"]]])));
    const failingGate = new SentinelGate(values, new ActiveRuns(), {
      tripQueue: makeTripQueue(),
      matcherForValues: () => ({
        findAll: () => {
          throw new Error("matcher failure");
        },
      }),
    });

    await expect(failingGate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "error",
    });

    const clockValues = [0, 0, 10, 16];
    let clockCalls = 0;
    const slowClockGate = new SentinelGate(values, new ActiveRuns(), {
      tripQueue: makeTripQueue(),
      now: () => clockValues[clockCalls++] ?? 16,
    });
    await expect(slowClockGate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("fails closed when timing itself errors and retains a trip if the hook throws", async () => {
    const gate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-value"]]]))),
      new ActiveRuns(),
      {
        now: () => {
          throw new Error("clock failed");
        },
        tripQueue: makeTripQueue(),
      },
    );

    await expect(gate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("fails closed when vault reads exceed the timeout", async () => {
    const slowReader: VaultRunReader = {
      version: async () => new Promise<number>(() => undefined),
      listRawValueEntries: () => Promise.resolve([]),
    };
    const gate = new SentinelGate(new VaultRunView(slowReader), new ActiveRuns(), {
      maxPrepareMs: 1,
      tripQueue: makeTripQueue(),
    });

    await expect(gate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("does not charge slow vault preparation to the scan budget", async () => {
    const slowReader: VaultRunReader = {
      version: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 1;
      },
      listRawValueEntries: () =>
        Promise.resolve([{ entityType: Code.parse("email"), rawValue: "known-value" }]),
    };
    const gate = new SentinelGate(new VaultRunView(slowReader), new ActiveRuns(), {
      maxPrepareMs: 100,
      maxScanMs: 5,
      matcherForValues: () => ({ findAll: () => [] }),
      tripQueue: makeTripQueue(),
    });

    await expect(gate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({ ok: true });
  });

  it("classifies over-budget matcher preparation failures as timeouts", async () => {
    let now = 0;
    const gate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-value"]]]))),
      new ActiveRuns(),
      {
        maxPrepareMs: 5,
        tripQueue: makeTripQueue(),
        now: () => now,
        matcherForValues: () => {
          now = 6;
          throw new Error("slow matcher build failed");
        },
      },
    );

    await expect(gate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("times out a slow scan and a slow scan that throws", async () => {
    let now = 0;
    const slowGate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-value"]]]))),
      new ActiveRuns(),
      {
        tripQueue: makeTripQueue(),
        now: () => now,
        matcherForValues: () => ({
          findAll: () => {
            now = 6;
            return [];
          },
        }),
      },
    );
    await expect(slowGate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });

    now = 0;
    const slowThrowGate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-value"]]]))),
      new ActiveRuns(),
      {
        tripQueue: makeTripQueue(),
        now: () => now,
        matcherForValues: () => ({
          findAll: () => {
            now = 6;
            throw new Error("slow matcher failure");
          },
        }),
      },
    );
    await expect(slowThrowGate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});

describe("assertSentinelGate", () => {
  it("requires a gate unless explicitly disabled outside production", () => {
    expect(() => {
      assertSentinelGate(undefined, undefined, "production");
    }).toThrow(SentinelRequiredError);
    expect(() => {
      assertSentinelGate(
        undefined,
        { sentinel: { minValueLength: 6, enabled: false }, correlation: { enabled: false } },
        "production",
      );
    }).toThrow(SentinelRequiredError);
    expect(() => {
      assertSentinelGate(
        undefined,
        { sentinel: { minValueLength: 6, enabled: false }, correlation: { enabled: false } },
        "test",
      );
    }).not.toThrow();
  });
});
