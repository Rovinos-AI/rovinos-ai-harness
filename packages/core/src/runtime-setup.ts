// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "@opentelemetry/api";
import { HarnessError, PiiConfigSchema } from "@harness/schemas";
import type { Code, Id, PiiConfig } from "@harness/schemas";
import { PiiEventStore, PiiToolPort } from "@harness/pii";
import type { EventStore } from "@harness/store";
import { createSandboxBackend, type SandboxBackend } from "@harness/sandbox";
import type { MessageSanitizer } from "@harness/models";
import { createRuntimeStore } from "./runtime-store.js";
import { createConfiguredModelPort } from "./runtime-model.js";
import { createRuntimeKeys } from "./runtime-keys.js";
import { createRuntimePii } from "./runtime-pii.js";
import { createRuntimePolicy } from "./runtime-policy.js";
import { resolveDataDir } from "./runtime-data-dir.js";
import { createRuntimeVault } from "./runtime-vault.js";
import { ensureTracing } from "./runtime-tracing-init.js";
import { missingModelPort, unavailableTool } from "./runtime-default-ports.js";
import { NaiveContext } from "./context/naive-context.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { resolveRuntimeRoles } from "./subagent/runtime.js";
import { systemClock, SystemIdGenerator } from "./runtime-ids.js";
import { McpConnectionError, McpToolPort } from "@harness/mcp";
import type { McpLogger } from "@harness/mcp";
import type { RoleRegistry } from "./roles.js";
import type { ToolPort } from "./ports.js";
import type {
  RuntimeComposition,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeVault,
} from "./runtime-config.js";
import type { Clock } from "./recorder.js";

const roleConfigLogger = diag.createComponentLogger({ namespace: "harness.core" });
const sandboxLogger = diag.createComponentLogger({ namespace: "harness.sandbox" });
const mcpDiagnosticLogger = diag.createComponentLogger({ namespace: "harness.mcp" });
const mcpLogger: McpLogger = {
  log: (event) => {
    mcpDiagnosticLogger.warn(
      event.code,
      event.code === "mcp_stderr"
        ? { serverId: event.serverId, bytes: event.bytes }
        : { serverId: event.serverId },
    );
  },
};

async function createConfiguredMcpToolPort(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<McpToolPort | undefined> {
  const servers = config.servers ?? [];
  if (overrides.tool !== undefined || servers.length === 0) {
    return undefined;
  }
  const secretResolver = overrides.secretResolver ?? {
    resolve: () => Promise.reject(new McpConnectionError("mcp_connect_failed")),
  };
  return McpToolPort.create(
    servers,
    {
      resolveSecret: async (ref) => (await secretResolver.resolve(ref)).reveal(),
      logger: mcpLogger,
      ...(overrides.mcpTransportFactory === undefined
        ? {}
        : { createTransport: overrides.mcpTransportFactory }),
    },
    { offloadBinaryResults: overrides.workspace !== undefined },
  );
}

async function closeSetupResources(options: {
  readonly mcpToolPort?: McpToolPort | undefined;
  readonly sandboxBackend?: SandboxBackend | undefined;
  readonly eventStore: EventStore | undefined;
  readonly vault: RuntimeVault | undefined;
  readonly disposeKeys: () => void;
}): Promise<void> {
  try {
    try {
      await options.mcpToolPort?.close();
    } finally {
      await options.sandboxBackend?.close?.();
    }
  } finally {
    try {
      await options.eventStore?.close();
    } finally {
      try {
        await options.vault?.close();
      } finally {
        options.disposeKeys();
      }
    }
  }
}

async function createRuntimeSandbox(config: RuntimeConfig, overrides: RuntimeOverrides) {
  if (overrides.sandboxBackend !== undefined) {
    return overrides.sandboxBackend;
  }
  const workspaceRoot = join(resolveDataDir(process.env, overrides.dataDir), "workspaces");
  // Read-only commands (harness context, store inspection) must not create runtime state.
  if (overrides.readOnlyStore !== true) {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await chmod(workspaceRoot, 0o700);
  }
  return createSandboxBackend(config.sandbox, {
    // Keep default commands inside runtime-owned state, never the caller's working tree.
    workspaceRoot,
    logger: {
      log: (code) => {
        sandboxLogger.warn(code);
      },
    },
    ...(overrides.secretResolver === undefined ? {} : { secretResolver: overrides.secretResolver }),
  });
}

function createRuntimeTool(
  config: RuntimeConfig,
  backend: SandboxBackend,
  overrides: RuntimeOverrides,
  mcpToolPort: McpToolPort | undefined,
) {
  const tool = overrides.tool ?? mcpToolPort ?? overrides.createTool?.(backend) ?? unavailableTool;
  if (config.pii?.enabled !== false && tool instanceof PiiToolPort) {
    throw new PiiToolPortAlreadyWrappedError();
  }
  return tool;
}

/** Creates runtime keys, closing a caller-supplied sandbox backend if key resolution fails. */
async function createKeysClosingSandbox(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<RuntimeComposition["keys"]> {
  try {
    return await createRuntimeKeys(config.keys, overrides);
  } catch (error) {
    await overrides.sandboxBackend?.close?.();
    throw error;
  }
}

/** Runtime-owned sandbox backend, MCP port and the composed tool port. */
interface RuntimeTools {
  readonly tool: ToolPort;
  readonly sandboxBackend: SandboxBackend;
  readonly mcpToolPort: McpToolPort | undefined;
}

/** Creates the sandbox backend and MCP port, closing whatever was created if a later step fails. */
async function createRuntimeTools(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<RuntimeTools> {
  const sandboxBackend = await createRuntimeSandbox(config, overrides);
  let mcpToolPort: McpToolPort | undefined;
  try {
    mcpToolPort = await createConfiguredMcpToolPort(config, overrides);
    const tool = createRuntimeTool(config, sandboxBackend, overrides, mcpToolPort);
    return { tool, sandboxBackend, mcpToolPort };
  } catch (error) {
    try {
      await mcpToolPort?.close();
    } finally {
      // A caller-supplied backend is closed once by setupRuntime's cleanup; close only our own.
      if (sandboxBackend !== overrides.sandboxBackend) {
        await sandboxBackend.close?.();
      }
    }
    throw error;
  }
}

function createRuntimeRoles(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
  tool: ToolPort,
): Promise<RoleRegistry> {
  return resolveRuntimeRoles(
    config,
    overrides.roleConfigDirectory ?? process.cwd(),
    tool,
    (code) => {
      roleConfigLogger.warn(code);
    },
  );
}

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
  options: {
    readonly ids: RuntimeComposition["ids"];
    readonly clock: Clock;
    readonly messageSanitizer?: MessageSanitizer;
  },
): Promise<RuntimeComposition["model"]> {
  return (
    overrides.model ??
    (await createConfiguredModelPort(config.models, {
      ids: options.ids,
      clock: options.clock,
      ...(overrides.providerAdapters === undefined
        ? {}
        : { providerAdapters: overrides.providerAdapters }),
      ...(overrides.secretResolver === undefined
        ? {}
        : { secretResolver: overrides.secretResolver }),
      ...(options.messageSanitizer === undefined
        ? {}
        : { messageSanitizer: options.messageSanitizer }),
    })) ??
    missingModelPort
  );
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

async function createRuntimeModelAndStore(options: {
  readonly config: RuntimeConfig;
  readonly piiConfig: PiiConfig;
  readonly overrides: RuntimeOverrides;
  readonly ids: RuntimeComposition["ids"];
  readonly clock: Clock;
  readonly vault: RuntimeVault;
  readonly scopes: RunScopeRegistry;
  readonly store: EventStore;
  readonly policyVersion: Code;
}): Promise<{
  readonly piiRuntime: ReturnType<typeof createRuntimePii>;
  readonly model: RuntimeComposition["model"];
  readonly store: EventStore;
}> {
  const piiRuntime = createRuntimePii({
    config: options.piiConfig,
    vault: options.vault,
    scopes: options.scopes,
    scopeOf: persistedScopeResolver(options.store, options.scopes),
    policyVersion: options.policyVersion,
    clock: options.clock,
  });
  const messageSanitizer: MessageSanitizer | undefined = options.piiConfig.enabled
    ? (messages, target, runId, recordPiiAction) =>
        piiRuntime.messageSanitizer.sanitize(messages, target, runId, recordPiiAction)
    : undefined;
  const model = await createRuntimeModel(options.config, options.overrides, {
    ids: options.ids,
    clock: options.clock,
    ...(messageSanitizer === undefined ? {} : { messageSanitizer }),
  });
  return {
    piiRuntime,
    model,
    store: options.piiConfig.enabled
      ? new PiiEventStore(options.store, piiRuntime.tokenizer)
      : options.store,
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
  const keys = await createKeysClosingSandbox(runtimeConfig, overrides);
  let vault: RuntimeVault | undefined;
  let eventStore: EventStore | undefined;
  let tools: RuntimeTools | undefined;
  try {
    const dataDir = resolveDataDir(process.env, overrides.dataDir);
    const runtimeVault = await createRuntimeVault({
      dataDir,
      config: runtimeConfig,
      overrides,
      keys,
      clock,
    });
    vault = runtimeVault;
    const scopes = overrides.scopeRegistry ?? new RunScopeRegistry();
    const policy = await createRuntimePolicy(runtimeConfig, overrides);
    const context = overrides.context ?? new NaiveContext();
    tools = await createRuntimeTools(runtimeConfig, overrides);
    const { tool, sandboxBackend } = tools;
    const roles = await createRuntimeRoles(runtimeConfig, overrides, tool);
    const rawStore = await createRuntimeStore(runtimeConfig, overrides, clock);
    eventStore = rawStore;
    const { piiRuntime, model, store } = await createRuntimeModelAndStore({
      config: runtimeConfig,
      piiConfig,
      overrides,
      ids,
      clock,
      vault: runtimeVault,
      scopes,
      store: rawStore,
      policyVersion: policy.version,
    });
    const managedMcpToolPort = tools.mcpToolPort;
    return {
      config: runtimeConfig,
      overrides,
      clock,
      ids,
      store,
      keys,
      sandboxBackend,
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
    await closeSetupResources({
      mcpToolPort: tools?.mcpToolPort,
      sandboxBackend: tools?.sandboxBackend ?? overrides.sandboxBackend,
      eventStore,
      vault,
      disposeKeys: () => {
        keys.dispose();
      },
    });
    throw error;
  }
}
