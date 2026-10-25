// SPDX-License-Identifier: Apache-2.0
import { inspect } from "node:util";
import { Code, Id } from "@rovinos/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countSkippedShortValues } from "../metrics.js";
import { StaticVaultReader } from "../testing.js";
import { RunValueSet, VaultRunView, type VaultRunReader } from "./run-values.js";

vi.mock("../metrics.js", () => ({
  countSkippedShortValues: vi.fn(),
}));

const runId = Id.parse("A".repeat(26));

function typedEntries(values: readonly string[]): { entityType: Code; rawValue: string }[] {
  return values.map((rawValue) => ({ entityType: Code.parse("email"), rawValue }));
}

describe("VaultRunView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches values while the run version is unchanged", async () => {
    const version = vi.fn().mockResolvedValue(1);
    const listRawValueEntries = vi.fn().mockResolvedValue(typedEntries(["cached-value"]));
    const reader: VaultRunReader = { version, listRawValueEntries };
    const view = new VaultRunView(reader);

    const first = await view.valuesFor(runId);
    const second = await view.valuesFor(runId);

    expect(second).toBe(first);
    expect(version).toHaveBeenCalledTimes(2);
    expect(listRawValueEntries).toHaveBeenCalledTimes(1);
  });

  it("loads a child run's values from its root vault scope", async () => {
    const rootId = Id.parse("B".repeat(26));
    const childId = Id.parse("C".repeat(26));
    const version = vi.fn().mockResolvedValue(3);
    const listRawValueEntries = vi.fn().mockResolvedValue(typedEntries(["shared-canary-value"]));
    const view = new VaultRunView({ version, listRawValueEntries }, {}, () => rootId);

    await expect(view.valuesFor(childId)).resolves.toMatchObject({
      version: 3,
      values: ["shared-canary-value"],
    });
    expect(version).toHaveBeenCalledExactlyOnceWith(rootId);
    expect(listRawValueEntries).toHaveBeenCalledExactlyOnceWith(rootId);
  });

  it("refreshes the set when a new vault value changes its version", async () => {
    let version = 1;
    let rawValues = ["first-value"];
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValueEntries: () => Promise.resolve(typedEntries(rawValues)),
    };
    const view = new VaultRunView(reader);

    const first = await view.valuesFor(runId);
    version = 2;
    rawValues = ["first-value", "second-value"];
    const refreshed = await view.valuesFor(runId);

    expect(refreshed).not.toBe(first);
    expect(refreshed).toMatchObject({ version: 2, values: rawValues, skippedShort: 0 });
  });

  it("trims, filters, deduplicates, and counts skipped values", async () => {
    const reader: VaultRunReader = {
      version: vi.fn().mockResolvedValue(1),
      listRawValueEntries: vi
        .fn()
        .mockResolvedValue(typedEntries(["short", "  long-value  ", "long-value", "x", "   "])),
    };
    const view = new VaultRunView(reader);

    await expect(view.valuesFor(runId)).resolves.toMatchObject({
      version: 1,
      values: ["long-value"],
      skippedShort: 3,
    });
    expect(countSkippedShortValues).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("retains every entity type associated with the same matched value", async () => {
    const rawValue = "shared-private-value";
    const view = new VaultRunView({
      version: () => Promise.resolve(1),
      listRawValueEntries: () =>
        Promise.resolve([
          { entityType: Code.parse("email"), rawValue },
          { entityType: Code.parse("phone"), rawValue },
        ]),
    });

    const valueSet = await view.valuesFor(runId);

    expect(valueSet.values).toEqual([rawValue]);
    expect(valueSet.entityTypesForValue(0)).toEqual(["email", "phone"]);
    expect(valueSet.entityTypesForValue(1)).toEqual([]);
    expect(JSON.stringify(valueSet)).not.toContain(rawValue);
  });

  it("counts only newly skipped short values when refreshing", async () => {
    let version = 1;
    let rawValues = ["x", "y", "z"];
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValueEntries: () => Promise.resolve(typedEntries(rawValues)),
    };
    const view = new VaultRunView(reader);

    await view.valuesFor(runId);
    version = 2;
    rawValues = ["x", "y", "z", "long-value"];
    await view.valuesFor(runId);

    expect(countSkippedShortValues).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("accepts a configured minimum length", async () => {
    const reader: VaultRunReader = {
      version: () => Promise.resolve(1),
      listRawValueEntries: () => Promise.resolve(typedEntries(["short-value", "longer-value"])),
    };
    const view = new VaultRunView(reader, { minValueLength: 12 });

    await expect(view.valuesFor(runId)).resolves.toMatchObject({
      values: ["longer-value"],
      skippedShort: 1,
    });
  });

  it("rejects invalid minimum lengths", () => {
    const reader: VaultRunReader = {
      version: () => Promise.resolve(0),
      listRawValueEntries: () => Promise.resolve([]),
    };

    expect(() => new VaultRunView(reader, { minValueLength: 0 })).toThrow();
  });

  it("evicts the least recently used run when the cache exceeds 64 runs", async () => {
    const loadCount = new Map<string, number>();
    const reader: VaultRunReader = {
      version: () => Promise.resolve(1),
      listRawValueEntries: (requestedRunId) => {
        loadCount.set(requestedRunId, (loadCount.get(requestedRunId) ?? 0) + 1);
        return Promise.resolve(typedEntries(["long-value"]));
      },
    };
    const view = new VaultRunView(reader);
    const idAt = (index: number): Id => Id.parse(String(index).padStart(26, "0"));

    for (let index = 0; index < 64; index += 1) {
      await view.valuesFor(idAt(index));
    }
    await view.valuesFor(idAt(0));
    await view.valuesFor(idAt(64));

    await view.valuesFor(idAt(0));
    await view.valuesFor(idAt(1));

    expect(loadCount.get(idAt(0))).toBe(1);
    expect(loadCount.get(idAt(1))).toBe(2);
  });

  it("forgets a run on request", async () => {
    const listRawValueEntries = vi.fn().mockResolvedValue(typedEntries(["long-value"]));
    const reader: VaultRunReader = {
      version: vi.fn().mockResolvedValue(1),
      listRawValueEntries,
    };
    const view = new VaultRunView(reader);

    await view.valuesFor(runId);
    view.forgetRun(runId);
    await view.valuesFor(runId);

    expect(listRawValueEntries).toHaveBeenCalledTimes(2);
  });

  it("uses the read-only static test reader", async () => {
    const reader = new StaticVaultReader(new Map([[runId, typedEntries(["static-value"])]]));

    await expect(reader.version(runId)).resolves.toBe(1);
    await expect(reader.listRawValues(runId)).resolves.toEqual(["static-value"]);
    await expect(reader.listRawValueEntries(runId)).resolves.toEqual(
      typedEntries(["static-value"]),
    );
    expect("put" in reader).toBe(false);
  });

  it("never prints raw values when a value set is stringified or inspected", () => {
    const canary = "canary-alice@example.test";
    const valueSet = new RunValueSet(
      2,
      [canary],
      [typedEntries([canary]).map(({ entityType }) => entityType)],
      1,
    );
    const outputs = [JSON.stringify(valueSet), inspect(valueSet), valueSet.inspect()];

    expect(outputs.every((output) => !output.includes(canary))).toBe(true);
    expect(JSON.stringify(valueSet)).toContain('"valueCount":1');
    expect(inspect(valueSet)).toContain('"skippedShort":1');
  });
});
