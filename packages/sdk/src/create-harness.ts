// SPDX-License-Identifier: Apache-2.0
import { createRuntime } from "@rovinos/core";
import { loadConfig, type HarnessConfig } from "@rovinos/config";
import { createHarnessClient } from "./harness.js";
import { runtimeOverridesFrom } from "./runtime-overrides.js";
import {
  CreateHarnessOptionsSchema,
  HarnessOverridesSchema,
  type CreateHarnessOptions,
  type Harness,
} from "./types.js";

/**
 * Creates a validated public SDK around the internal runtime.
 *
 * @param options - Validated config object or config path, optional adapters, and content authorizer.
 * @returns Programmatic run, metadata, approval, and subscription operations.
 */
export async function createHarness(options: CreateHarnessOptions): Promise<Harness> {
  const parsedOptions = CreateHarnessOptionsSchema.parse(options);
  const runtimeOverrides = runtimeOverridesFrom(
    HarnessOverridesSchema.parse(parsedOptions.overrides ?? {}),
  );
  const config: HarnessConfig =
    "config" in parsedOptions
      ? parsedOptions.config
      : await loadConfig({ configPath: parsedOptions.configPath });
  const runtime = await createRuntime(config, runtimeOverrides);
  return createHarnessClient({
    runtime,
    piiEnabled: config.pii.enabled,
    correlationEnabled: config.telemetry.correlation.enabled,
    shutdownGraceMs: config.run.shutdownGraceMs,
    contentAuthorizer: parsedOptions.contentAuthorizer,
  });
}
