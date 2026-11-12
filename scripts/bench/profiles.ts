// SPDX-License-Identifier: Apache-2.0
import type { BenchmarkProfile } from "./common.js";

/** Sampling configurations used by smoke and nightly runs. */
export const BENCHMARK_PROFILES: Readonly<Record<"smoke" | "nightly", BenchmarkProfile>> = {
  smoke: { name: "smoke", durationMs: 10, warmupMs: 0 },
  nightly: { name: "nightly", durationMs: 1000, warmupMs: 200 },
};

export type { BenchmarkProfile };
