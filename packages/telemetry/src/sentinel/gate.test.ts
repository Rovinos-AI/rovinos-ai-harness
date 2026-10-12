// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countSentinelScopeReduced } from "../metrics.js";
import { ActiveRuns } from "./active-runs.js";
import { assertSentinelGate, SentinelGate, SentinelRequiredError } from "./gate.js";
import { VaultRunView, type VaultRunReader } from "./run-values.js";

vi.mock("../metrics.js", () => ({
  countSentinelScopeReduced: vi.fn(),
}));

const firstRun = Id.parse("A".repeat(26));
const secondRun = Id.parse("B".repeat(26));

function createReader(valuesByRun: Map<string, string[]>): VaultRunReader {
  return {
    version: (runId) => Promise.resolve(valuesByRun.get(runId)?.length ?? 0),
    listRawValues: (runId) => Promise.resolve(valuesByRun.get(runId) ?? []),
  };
}

describe("SentinelGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a run-scoped matcher and enqueues metadata-only trips on a hit", async () => {
    const enqueueTrip = vi.fn();
    const matcherForValues = vi.fn((values: readonly string[]) => ({
      hasMatch: (text: string) => values.some((value) => text.includes(value)),
    }));
    const gate = new SentinelGate(
      new VaultRunView(createReader(new Map([[firstRun, ["known-raw-value"]]]))),
      new ActiveRuns(),
      { matcherForValues, onTrip: enqueueTrip },
    );

    await expect(gate.check({ runId: firstRun, text: "payload known-raw-value" })).resolves.toEqual(
      {
        ok: false,
        reason: "hit",
      },
    );
    expect(matcherForValues).toHaveBeenCalledWith(["known-raw-value"]);
    expect(enqueueTrip).toHaveBeenCalledWith({ runId: firstRun, reason: "hit" });
    expect(JSON.stringify(enqueueTrip.mock.calls)).not.toContain("known-raw-value");
    expect(gate.drainTrips()).toEqual([{ runId: firstRun, reason: "hit" }]);
    expect(gate.drainTrips()).toEqual([]);
  });

  it("catches a child canary using the shared root vault scope", async () => {
    const childRun = Id.parse("C".repeat(26));
    const rootCanary = "root-scope-private-value";
    const reader = createReader(new Map([[firstRun, [rootCanary]]]));
    const view = new VaultRunView(reader, {}, () => firstRun);
    const gate = new SentinelGate(view, new ActiveRuns());

    await expect(
      gate.check({ runId: childRun, text: `child span ${rootCanary}` }),
    ).resolves.toEqual({ ok: false, reason: "hit" });
  });

  it("uses and caches a combined matcher for active and grace-period runs", async () => {
    const runs = new ActiveRuns({ now: () => 1 });
    runs.register(firstRun);
    runs.register(secondRun);
    runs.terminate(firstRun);
    const matcherForValues = vi.fn((values: readonly string[]) => ({
      hasMatch: (text: string) => values.some((value) => text.includes(value)),
    }));
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
      { matcherForValues },
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
    const matcherForValues = vi.fn((values: readonly string[]) => ({
      hasMatch: (text: string) => values.some((value) => text.includes(value)),
    }));
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
      { maxCombinedValues: 1, matcherForValues },
    );

    await expect(gate.check({ text: "second-value" })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });
    await expect(gate.check({ text: "safe" })).resolves.toEqual({ ok: true });
    expect(countSentinelScopeReduced).toHaveBeenCalledOnce();
    expect(matcherForValues).toHaveBeenCalledTimes(2);
  });

  it("refreshes the matcher when a run's vault version changes", async () => {
    let values = ["first-value"];
    let version = 1;
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValues: () => Promise.resolve(values),
    };
    const gate = new SentinelGate(new VaultRunView(reader));

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
      matcherForValues: () => ({
        hasMatch: () => {
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
        onTrip: () => {
          throw new Error("trip hook failed");
        },
      },
    );

    await expect(gate.check({ runId: firstRun, text: "payload" })).resolves.toEqual({
      ok: false,
      reason: "error",
    });
    expect(gate.drainTrips()).toEqual([{ runId: firstRun, reason: "error" }]);
  });

  it("fails closed when vault reads exceed the timeout", async () => {
    const slowReader: VaultRunReader = {
      version: async () => new Promise<number>(() => undefined),
      listRawValues: () => Promise.resolve([]),
    };
    const gate = new SentinelGate(new VaultRunView(slowReader), new ActiveRuns(), {
      maxPrepareMs: 1,
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
      listRawValues: () => Promise.resolve(["known-value"]),
    };
    const gate = new SentinelGate(new VaultRunView(slowReader), new ActiveRuns(), {
      maxPrepareMs: 100,
      maxScanMs: 5,
      matcherForValues: () => ({ hasMatch: () => false }),
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
        now: () => now,
        matcherForValues: () => ({
          hasMatch: () => {
            now = 6;
            return false;
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
        now: () => now,
        matcherForValues: () => ({
          hasMatch: () => {
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
        { sentinel: { minValueLength: 6, enabled: false } },
        "production",
      );
    }).toThrow(SentinelRequiredError);
    expect(() => {
      assertSentinelGate(undefined, { sentinel: { minValueLength: 6, enabled: false } }, "test");
    }).not.toThrow();
  });
});
