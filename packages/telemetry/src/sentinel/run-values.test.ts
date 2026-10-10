// SPDX-License-Identifier: Apache-2.0
import { inspect } from "node:util";
import { Id } from "@harness/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countSkippedShortValues } from "../metrics.js";
import { StaticVaultReader } from "../testing.js";
import { RunValueSet, VaultRunView, type VaultRunReader } from "./run-values.js";

vi.mock("../metrics.js", () => ({
  countSkippedShortValues: vi.fn(),
}));

const runId = Id.parse("A".repeat(26));

describe("VaultRunView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches values while the run version is unchanged", async () => {
    const version = vi.fn().mockResolvedValue(1);
    const listRawValues = vi.fn().mockResolvedValue(["cached-value"]);
    const reader: VaultRunReader = { version, listRawValues };
    const view = new VaultRunView(reader);

    const first = await view.valuesFor(runId);
    const second = await view.valuesFor(runId);

    expect(second).toBe(first);
    expect(version).toHaveBeenCalledTimes(2);
    expect(listRawValues).toHaveBeenCalledTimes(1);
  });

  it("refreshes the set when a new vault value changes its version", async () => {
    let version = 1;
    let rawValues = ["first-value"];
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValues: () => Promise.resolve(rawValues),
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
      listRawValues: vi
        .fn()
        .mockResolvedValue(["short", "  long-value  ", "long-value", "x", "   "]),
    };
    const view = new VaultRunView(reader);

    await expect(view.valuesFor(runId)).resolves.toMatchObject({
      version: 1,
      values: ["long-value"],
      skippedShort: 3,
    });
    expect(countSkippedShortValues).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("counts only newly skipped short values when refreshing", async () => {
    let version = 1;
    let rawValues = ["x", "y", "z"];
    const reader: VaultRunReader = {
      version: () => Promise.resolve(version),
      listRawValues: () => Promise.resolve(rawValues),
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
      listRawValues: () => Promise.resolve(["short-value", "longer-value"]),
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
      listRawValues: () => Promise.resolve([]),
    };

    expect(() => new VaultRunView(reader, { minValueLength: 0 })).toThrow();
  });

  it("evicts the least recently used run when the cache exceeds 64 runs", async () => {
    const loadCount = new Map<string, number>();
    const reader: VaultRunReader = {
      version: () => Promise.resolve(1),
      listRawValues: (requestedRunId) => {
        loadCount.set(requestedRunId, (loadCount.get(requestedRunId) ?? 0) + 1);
        return Promise.resolve(["long-value"]);
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
    const listRawValues = vi.fn().mockResolvedValue(["long-value"]);
    const reader: VaultRunReader = {
      version: vi.fn().mockResolvedValue(1),
      listRawValues,
    };
    const view = new VaultRunView(reader);

    await view.valuesFor(runId);
    view.forgetRun(runId);
    await view.valuesFor(runId);

    expect(listRawValues).toHaveBeenCalledTimes(2);
  });

  it("uses the read-only static test reader", async () => {
    const reader = new StaticVaultReader(new Map([[runId, ["static-value"]]]));

    await expect(reader.version(runId)).resolves.toBe(1);
    await expect(reader.listRawValues(runId)).resolves.toEqual(["static-value"]);
    expect("put" in reader).toBe(false);
  });

  it("never prints raw values when a value set is stringified or inspected", () => {
    const canary = "canary-alice@example.test";
    const valueSet = new RunValueSet(2, [canary], 1);
    const outputs = [JSON.stringify(valueSet), inspect(valueSet), valueSet.inspect()];

    expect(outputs.every((output) => !output.includes(canary))).toBe(true);
    expect(JSON.stringify(valueSet)).toContain('"valueCount":1');
    expect(inspect(valueSet)).toContain('"skippedShort":1');
  });
});
