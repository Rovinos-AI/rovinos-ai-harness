// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "@opentelemetry/api";
import { HarnessError, PiiConfigSchema } from "@harness/schemas";
import type { PiiConfig } from "@harness/schemas";
import { PiiEventStore, PiiToolPort } from "@harness/pii";
import { SqliteVault } from "@harness/vault";
import { createConfiguredModelPort } from "./runtime-model.js";
import { createRuntimeKeys } from "./runtime-keys.js";
import { createRuntimePii } from "./runtime-pii.js";
import { createRuntimePolicy } from "./runtime-policy.js";
import { resolveDataDir } from "./runtime-data-dir.js";
import { ensureTracing } from "./runtime-tracing-init.js";
import { createSqliteStore } from "./runtime-store.js";
import { missingModelPort, unavailableTool } from "./runtime-default-ports.js";
import { NaiveContext } from "./context/naive-context.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { resolveRuntimeRoles } from "./subagent/runtime.js";
import { systemClock, SystemIdGenerator } from "./runtime-ids.js";
import type { RoleRegistry } from "./roles.js";
import type { RuntimeComposition, RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";
import type { Clock } from "./recorder.js";

const roleConfigLogger = diag.createComponentLogger({ namespace: "harness.core" });

/** Runtime dependencies ready to be assembled into the public runtime API. */
export type RuntimeSetup = RuntimeComposition & {
  readonly roles: RoleRegistry;
  readonly scopes: RunScopeRegistry;
};

class PiiDisabledInProductionError extends HarnessError {
  readonly code = "pii_disabled_in_production";

  constructor() {
    super("PII cannot be disabled in production.");
  }
}

class PiiToolPortAlreadyWrappedError extends HarnessError {
  readonly code = "pii_tool_port_already_wrapped";

  constructor() {
    super("The runtime cannot accept an already wrapped PII tool port.");
  }
}

function validatePiiConfig(config: RuntimeConfig, overrides: RuntimeOverrides): PiiConfig {
  const pii = PiiConfigSchema.parse(config.pii ?? {});
  if (!pii.enabled && process.env.NODE_ENV === "production") {
    throw new PiiDisabledInProductionError();
  }
  if (pii.enabled && overrides.tool instanceof PiiToolPort) {
    throw new PiiToolPortAlreadyWrappedError();
  }
  return pii;
}

async function createRuntimeModel(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
  ids: RuntimeComposition["ids"],
  clock: Clock,
): Promise<RuntimeComposition["model"]> {
  return (
    overrides.model ??
    (await createConfiguredModelPort(config.models, {
      ids,
      clock,
      ...(overrides.providerAdapters === undefined
        ? {}
        : { providerAdapters: overrides.providerAdapters }),
      ...(overrides.secretResolver === undefined
        ? {}
        : { secretResolver: overrides.secretResolver }),
    })) ??
    missingModelPort
  );
}

async function createRuntimeVault(
  dataDir: string,
  overrides: RuntimeOverrides,
  keys: RuntimeComposition["keys"],
  clock: Clock,
): Promise<SqliteVault> {
  const vaultPath = join(dataDir, "vault.db");
  // Development runtimes with injected stores and no data directory keep their
  // SQLite vault state transient.
  const transient =
    overrides.store !== undefined &&
    overrides.dataDir === undefined &&
    process.env.HARNESS_DATA_DIR === undefined &&
    process.env.NODE_ENV !== "production";
  if (overrides.readOnlyStore !== true && !transient) {
    await mkdir(dataDir, { recursive: true });
  }
  const path =
    transient || (overrides.readOnlyStore === true && !existsSync(vaultPath))
      ? ":memory:"
      : vaultPath;
  return new SqliteVault(path, keys, () => clock.now());
}

/** Builds validated ports and owned storage dependencies for `createRuntime`. */
/**
 * Resolve validated runtime configuration and create owned storage dependencies.
 * @param config - Validated run configuration.
 * @param overrides - Optional runtime ports and test dependencies.
 * @returns The dependencies needed to compose a runtime.
 */
export async function setupRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<RuntimeSetup> {
  const piiConfig = validatePiiConfig(config, overrides);
  const runtimeConfig = { ...config, pii: piiConfig };
  ensureTracing();
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? new SystemIdGenerator(clock);
  const keys = await createRuntimeKeys(runtimeConfig.keys, overrides);
  let vault: SqliteVault | undefined;
  try {
    const model = await createRuntimeModel(runtimeConfig, overrides, ids, clock);
    const dataDir = resolveDataDir(process.env, overrides.dataDir);
    const runtimeVault = await createRuntimeVault(dataDir, overrides, keys, clock);
    vault = runtimeVault;
    const scopes = overrides.scopeRegistry ?? new RunScopeRegistry();
    const piiRuntime = createRuntimePii(piiConfig, runtimeVault, scopes);
    const policy = await createRuntimePolicy(runtimeConfig, overrides);
    const context = overrides.context ?? new NaiveContext();
    const tool = overrides.tool ?? unavailableTool;
    const roles = await resolveRuntimeRoles(
      runtimeConfig,
      overrides.roleConfigDirectory ?? process.cwd(),
      tool,
      (code) => {
        roleConfigLogger.warn(code);
      },
    );
    const rawStore =
      overrides.store ?? (await createSqliteStore(dataDir, overrides.readOnlyStore === true));
    const store = piiConfig.enabled ? new PiiEventStore(rawStore, piiRuntime.tokenizer) : rawStore;
    return {
      config: runtimeConfig,
      overrides,
      clock,
      ids,
      store,
      keys,
      vault: runtimeVault,
      vaultResolver: piiRuntime.resolver,
      pii: piiConfig.enabled ? { config: piiConfig, ...piiRuntime } : undefined,
      model,
      tool,
      policy,
      policyVersion: policy.version,
      context,
      roles,
      scopes,
    };
  } catch (error) {
    try {
      vault?.close();
    } finally {
      keys.dispose();
    }
    throw error;
  }
}
