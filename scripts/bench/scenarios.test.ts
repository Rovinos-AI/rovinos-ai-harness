// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { BENCHMARK_PROFILES, runBenchmarks } from "./scenarios.js";

describe("benchmark scenarios", () => {
  it("smoke-runs all local scenarios with small inputs", async () => {
    const result = await runBenchmarks(BENCHMARK_PROFILES.smoke);
    const names = new Set(result.metrics.map(({ name }) => name));

    expect(result.sample.profile).toBe("smoke");
    expect(names).toEqual(
      new Set([
        "store.sqlite.append.batch_1",
        "store.sqlite.append.batch_10",
        "store.sqlite.append.batch_100",
        "store.read_fold.100k",
        "store.resume.full_log",
        "store.resume.snapshot_tail",
        "sentinel.p95.1000",
        "sentinel.p95.10000",
        "sentinel.p95.100000",
        "pii.tokenizer.1mib",
        "telemetry.allowlist_sentinel.spans",
        "queue.claim.4_workers",
        "sdk.full_history.100k",
        "sdk.pending_approval.1000_runs",
        "sdk.content_stream.backpressure",
        "sdk.mcp_catalog.1000_tools",
        "sdk.mcp.rejection_storm.1000",
        "mcp.mixed_result_offload",
      ]),
    );
    expect(result.metrics.every(({ sampleCount }) => sampleCount > 0)).toBe(true);
  });
});
