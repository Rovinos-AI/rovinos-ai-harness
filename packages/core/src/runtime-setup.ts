// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "@opentelemetry/api";
import { HarnessError, PiiConfigSchema } from "@harness/schemas";
import type { Id, PiiConfig } from "@harness/schemas";
import { PiiEventStore, PiiToolPort } from "@harness/pii";
import { SqliteVault, VaultOperationError } from "@harness/vault";
import type { TokenType, VaultTerminalRunsQuery } from "@harness/vault";
import type { EventStore } from "@harness/store";
import { createRuntimeStore } from "./runtime-store.js";
import { createConfiguredModelPort } from "./runtime-model.js";
import { createRuntimeKeys } from "./runtime-keys.js";
import { createRuntimePii } from "./runtime-pii.js";
import { createRuntimePolicy } from "./runtime-policy.js";
import { resolveDataDir } from "./runtime-data-dir.js";
import { ensureTracing } from "./runtime-tracing-init.js";
import { missingModelPort, unavailableTool } from "./runtime-default-ports.js";
import { NaiveContext } from "./context/naive-context.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { resolveRuntimeRoles } from "./subagent/runtime.js";
import { systemClock, SystemIdGenerator } from "./runtime-ids.js";
import { McpConnectionError, McpToolPort } from "@harness/mcp";
import type { RoleRegistry } from "./roles.js";
import type {
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeVault,
} from "./runtime-config.js";
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

class TransientVaultInProductionError extends HarnessError {
  readonly code = "transient_vault_in_production";

  constructor() {
    super("A transient vault cannot be used in production.");
  }
}

class EmptyReadOnlyVault implements RuntimeVault {
  private closed = false;

  put(): Promise<TokenType> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  resolve(): Promise<string | undefined> {
    return this.closed
      ? Promise.reject(new VaultOperationError("vault_unavailable"))
      : Promise.resolve(undefined);
  }

  markTerminal(): Promise<void> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  listTerminalRunsBefore(_query: VaultTerminalRunsQuery): Promise<readonly Id[]> {
    return Promise.resolve([]);
  }

  purge(): Promise<number> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  stats(): Promise<{ entries: number }> {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }

  close(): void {
    this.closed = true;
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
): Promise<RuntimeVault> {
  const vaultPath = join(dataDir, "vault.db");
  const transient = overrides.transientVault === true && overrides.readOnlyStore !== true;
  if (transient && process.env.NODE_ENV === "production") {
    throw new TransientVaultInProductionError();
  }
  if (overrides.readOnlyStore === true && !existsSync(vaultPath)) {
    return new EmptyReadOnlyVault();
  }
  if (overrides.readOnlyStore !== true && !transient) {
    await mkdir(dataDir, { recursive: true });
  }
  return new SqliteVault(transient ? ":memory:" : vaultPath, keys, () => clock.now(), {
    readonly: overrides.readOnlyStore === true,
  });
}

function persistedScopeResolver(store: EventStore, scopes: RunScopeRegistry) {
  const pending = new Map<Id, Promise<Id>>();
  const resolve = async (runId: Id, visited: Set<Id>): Promise<Id> => {
    const registered = scopes.registeredScopeOf(runId);
    if (registered !== undefined) {
      return registered;
    }
    if (visited.has(runId)) {
      return runId;
    }
    visited.add(runId);
    let scopeId: Id | undefined;
    let parentRunId: Id | undefined;
    for await (const event of store.read(runId, { fromSeq: 0, toSeq: 0 })) {
      if (event.type === "run_created") {
        scopeId = event.scopeId;
        parentRunId = event.parentRunId;
        break;
      }
    }
    scopeId ??= parentRunId === undefined ? runId : await resolve(parentRunId, visited);
    scopes.register(runId, scopeId);
    return scopeId;
  };
  return (runId: Id): Promise<Id> => {
    const known = scopes.registeredScopeOf(runId);
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    const existing = pending.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const resolution = resolve(runId, new Set<Id>());
    pending.set(runId, resolution);
    return resolution;
  };
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
  let vault: RuntimeVault | undefined;
  let eventStore: EventStore | undefined;
  let mcpToolPort: McpToolPort | undefined;
  try {
    const model = await createRuntimeModel(runtimeConfig, overrides, ids, clock);
    const dataDir = resolveDataDir(process.env, overrides.dataDir);
    const runtimeVault = await createRuntimeVault(dataDir, overrides, keys, clock);
    vault = runtimeVault;
    const scopes = overrides.scopeRegistry ?? new RunScopeRegistry();
    const policy = await createRuntimePolicy(runtimeConfig, overrides);
    const context = overrides.context ?? new NaiveContext();
    if (overrides.tool === undefined && (runtimeConfig.servers?.length ?? 0) > 0) {
      const secretResolver = overrides.secretResolver ?? {
        resolve: () => Promise.reject(new McpConnectionError("mcp_connect_failed")),
      };
      mcpToolPort = await McpToolPort.create(runtimeConfig.servers ?? [], {
        resolveSecret: async (ref) => (await secretResolver.resolve(ref)).reveal(),
        ...(overrides.mcpTransportFactory === undefined
          ? {}
          : { createTransport: overrides.mcpTransportFactory }),
      });
    }
    const tool = overrides.tool ?? mcpToolPort ?? unavailableTool;
    const roles = await resolveRuntimeRoles(
      runtimeConfig,
      overrides.roleConfigDirectory ?? process.cwd(),
      tool,
      (code) => {
        roleConfigLogger.warn(code);
      },
    );
    const rawStore = await createRuntimeStore(runtimeConfig, overrides, clock);
    eventStore = rawStore;
    const piiRuntime = createRuntimePii({
      config: piiConfig,
      vault: runtimeVault,
      scopes,
      scopeOf: persistedScopeResolver(rawStore, scopes),
      policyVersion: policy.version,
      clock,
    });
    const store = piiConfig.enabled ? new PiiEventStore(rawStore, piiRuntime.tokenizer) : rawStore;
    const managedMcpToolPort = mcpToolPort;
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
      ...(managedMcpToolPort === undefined
        ? {}
        : { closeToolPort: () => managedMcpToolPort.close() }),
      policy,
      policyVersion: policy.version,
      context,
      roles,
      scopes,
    };
  } catch (error) {
    try {
      await mcpToolPort?.close();
    } finally {
      try {
        await eventStore?.close();
      } finally {
        try {
          vault?.close();
        } finally {
          keys.dispose();
        }
      }
    }
    throw error;
  }
}
