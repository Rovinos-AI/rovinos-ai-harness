// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  BenchmarkBudgetsSchema,
  BenchmarkResultSchema,
} from "./contracts.js";
import { compareBenchmarkResults, formatComparison } from "./compare.js";

const budgets = BenchmarkBudgetsSchema.parse({
  schemaVersion: 1,
  environment: { runner: "ubuntu-24.04", description: "Synthetic test environment." },
  sample: {
    profile: "nightly",
    durationMs: 1000,
    warmupMs: 100,
    minimumSamples: 10,
    note: "Synthetic test sample.",
  },
  absolute: [
    { metric: "store.append", direction: "min", limit: 100, unit: "events/s" },
    { metric: "fold.duration", direction: "max", limit: 100, unit: "ms" },
  ],
  relative: [
    { metric: "store.append", direction: "min", maxRegression: 0.2, unit: "events/s" },
  ],
});

function result(metrics: readonly { name: string; value: number; unit: "events/s" | "ms" }[]) {
  return BenchmarkResultSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-12T00:00:00.000Z",
    environment: {
      runner: "ubuntu-24.04",
      platform: "linux",
      architecture: "x64",
      cpu: "synthetic",
      cpuCount: 2,
      memoryBytes: 1_000_000_000,
      node: "v26",
    },
    sample: { profile: "nightly", durationMs: 1000, warmupMs: 100 },
    metrics: metrics.map((metric) => ({ ...metric, sampleCount: 10 })),
  });
}

describe("compareBenchmarkResults", () => {
  it("reports absolute budget violations", () => {
    expect(
      compareBenchmarkResults(
        budgets,
        result([
          { name: "store.append", value: 80, unit: "events/s" },
          { name: "fold.duration", value: 101, unit: "ms" },
        ]),
        result([{ name: "store.append", value: 100, unit: "events/s" }]),
      ).map(({ metric, code }) => [metric, code]),
    ).toEqual([
      ["store.append", "absolute_exceeded"],
      ["fold.duration", "absolute_exceeded"],
    ]);
  });

  it("fails relative regressions beyond the configured percentage", () => {
    const violations = compareBenchmarkResults(
      budgets,
      result([
        { name: "store.append", value: 79, unit: "events/s" },
        { name: "fold.duration", value: 90, unit: "ms" },
      ]),
      result([{ name: "store.append", value: 100, unit: "events/s" }]),
    );
    expect(violations.map(({ metric, code }) => [metric, code])).toEqual([
      ["store.append", "absolute_exceeded"],
      ["store.append", "relative_regression"],
    ]);
    expect(violations.at(-1)).toMatchObject({ limit: 80 });
  });

  it("prints every violation for a metric", () => {
    const current = result([
      { name: "store.append", value: 79, unit: "events/s" },
      { name: "fold.duration", value: 90, unit: "ms" },
    ]);
    const baseline = result([{ name: "store.append", value: 100, unit: "events/s" }]);
    const table = formatComparison(
      budgets,
      current,
      baseline,
      compareBenchmarkResults(budgets, current, baseline),
    );
    expect(table).toContain("absolute_exceeded, relative_regression");
  });

  it("requires a baseline for relative budgets unless explicitly bootstrapping", () => {
    const current = result([
      { name: "store.append", value: 100, unit: "events/s" },
      { name: "fold.duration", value: 1, unit: "ms" },
    ]);
    expect(compareBenchmarkResults(budgets, current).map(({ code }) => code)).toEqual([
      "baseline_missing",
    ]);
    expect(compareBenchmarkResults(budgets, current, undefined, true)).toEqual([]);
  });

  it("reports a missing metric rather than silently skipping its budget", () => {
    expect(
      compareBenchmarkResults(
        budgets,
        result([{ name: "fold.duration", value: 1, unit: "ms" }]),
        result([{ name: "store.append", value: 100, unit: "events/s" }]),
      ),
    ).toContainEqual({ metric: "store.append", code: "result_missing" });
  });

  it("rejects measurements with fewer samples than the committed minimum", () => {
    const sparse = BenchmarkResultSchema.parse({
      ...result([
        { name: "store.append", value: 100, unit: "events/s" },
        { name: "fold.duration", value: 1, unit: "ms" },
      ]),
      metrics: [
        { name: "store.append", value: 100, unit: "events/s", sampleCount: 9 },
        { name: "fold.duration", value: 1, unit: "ms", sampleCount: 10 },
      ],
    });
    expect(
      compareBenchmarkResults(
        budgets,
        sparse,
        result([{ name: "store.append", value: 100, unit: "events/s" }]),
      ),
    ).toContainEqual({
      metric: "store.append",
      code: "sample_count_low",
      actual: 9,
      limit: 10,
      unit: "samples",
    });
  });

  it("does not compare runs from a different runner environment", () => {
    const current = result([
      { name: "store.append", value: 100, unit: "events/s" },
      { name: "fold.duration", value: 1, unit: "ms" },
    ]);
    const mismatched = BenchmarkResultSchema.parse({
      ...current,
      environment: { ...current.environment, runner: "local" },
    });
    expect(
      compareBenchmarkResults(
        budgets,
        mismatched,
        result([{ name: "store.append", value: 100, unit: "events/s" }]),
      ),
    ).toContainEqual({ metric: "environment.runner", code: "environment_mismatch" });
  });
});
