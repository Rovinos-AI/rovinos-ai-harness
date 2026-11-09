// SPDX-License-Identifier: Apache-2.0
import { TelemetryConfigSchema } from "@rovinos/schemas";
import { assertSinkPolicies } from "@rovinos/telemetry";
import { resolveCollectorConfigDir } from "./runtime-data-dir.js";
import { assertRuntimeOverrideRequirements } from "./runtime-overrides.js";
import type { RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

/** Validates runtime overrides and sink policies before runtime resources are created. */
export async function assertRuntimePreflight(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<void> {
  assertRuntimeOverrideRequirements(overrides);
  await assertSinkPolicies(config.telemetry ?? TelemetryConfigSchema.parse({}), {
    collectorConfigDir: resolveCollectorConfigDir(process.env),
  });
}
