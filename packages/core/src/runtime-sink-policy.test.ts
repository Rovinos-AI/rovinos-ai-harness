// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunConfigSchema, TelemetryConfigSchema } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("createRuntime sink policies", () => {
  it("fails before runtime setup when a configured sink has no collector policy files", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-runtime-sink-policy-"));
    vi.stubEnv("HARNESS_COLLECTOR_CONFIG_DIR", temporaryDirectory);

    await expect(
      createRuntime({
        run: RunConfigSchema.parse({}),
        telemetry: TelemetryConfigSchema.parse({
          sinks: [{ id: "events", kind: "datadog" }],
        }),
      }),
    ).rejects.toMatchObject({ code: "sink_policy_violation" });
  });
});
