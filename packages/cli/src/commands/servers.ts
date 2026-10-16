// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, type HarnessConfig } from "@harness/config";
import {
  McpConnection,
  McpConnectionError,
  McpAuthRequiredError,
  OAuthTokenStore,
  OAuthTokenStoreError,
  startMcpOAuthLogin,
  ToolRegistry,
  ToolRegistryError,
  type McpConnectionDependencies,
  type McpTool,
} from "@harness/mcp";
import {
  Code,
  HarnessError,
  ServersCheckResultSchema,
  type KeyProvider,
  type ServerConfig,
} from "@harness/schemas";
import { LocalKeyProvider } from "@harness/vault";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import type { CliContext, CommandModule } from "../command.js";
import type { Output } from "../output.js";

const MCP_PROTOCOL_VERSION_SCHEMA = z.iso.date();
const APPS_EXTENSION_WARNING = Code.parse("annotations_require_internal");
const TRACE_DISABLED_WARNING = Code.parse("trace_propagation_disabled");
const TOOL_HEADER_INVALID = Code.parse("tool_header_invalid");
const ServerAuthCommandResultSchema = z
  .object({
    status: z.enum(["authorization_required", "authorized", "logged_out"]),
    authorizationUrl: z.url().optional(),
  })
  .strict();

type ServersCommandOverrides = Pick<McpConnectionDependencies, "createTransport" | "now"> & {
  readonly openBrowser?: (url: string) => Promise<void>;
};

interface DiscoveryResult {
  readonly config: ServerConfig;
  readonly protocolEra: "legacy" | "modern" | "unknown";
  readonly protocolVersion: string | undefined;
  readonly supportsApps: boolean;
  readonly tools: readonly McpTool[];
  readonly excludedToolCount: number;
  readonly toolCount: number;
  readonly connectLatencyMs: number;
  readonly reachable: boolean;
  readonly errorCode?: string;
}

class ServersCheckFailedError extends HarnessError {
  override readonly code = "servers_check_failed";

  constructor() {
    super("servers_check_failed");
  }
}

class ServersCommandError extends HarnessError {
  override readonly code: "mcp_server_not_found" | "mcp_auth_required" | "key_config_required" | "server_browser_open_failed";

  constructor(
    code: "mcp_server_not_found" | "mcp_auth_required" | "key_config_required" | "server_browser_open_failed",
  ) {
    super(code);
    this.code = code;
  }
}

function protocolVersionOf(version: string | undefined): string {
  return version !== undefined && MCP_PROTOCOL_VERSION_SCHEMA.safeParse(version).success
    ? version
    : "unknown";
}

function propagationFor(server: ServerConfig): {
  readonly tracePropagation: "yes" | "no";
  readonly tracePropagationReason: "external" | "disabled" | "enabled";
} {
  if (server.trust === "external") {
    return { tracePropagation: "no", tracePropagationReason: "external" };
  }
  return server.propagateTrace
    ? { tracePropagation: "yes", tracePropagationReason: "enabled" }
    : { tracePropagation: "no", tracePropagationReason: "disabled" };
}

function warningsFor(server: ServerConfig): Code[] {
  const warnings: Code[] = [];
  if (server.trust === "internal" && !server.propagateTrace) {
    warnings.push(TRACE_DISABLED_WARNING);
  }
  if (server.trust === "external" && server.useAnnotations) {
    warnings.push(APPS_EXTENSION_WARNING);
  }
  return warnings;
}

async function discoverServers(
  servers: readonly ServerConfig[],
  context: Parameters<CommandModule["register"]>[1],
  overrides: ServersCommandOverrides | undefined,
): Promise<DiscoveryResult[]> {
  const defaultResolver = new CompositeSecretResolver();
  const dependencies: McpConnectionDependencies = {
    resolveSecret: async (ref, signal) =>
      context.secretResolver === undefined
        ? (await defaultResolver.resolve(ref, signal)).reveal()
        : (await context.secretResolver.resolve(ref, signal)).reveal(),
    env: process.env,
    ...(overrides?.createTransport === undefined
      ? {}
      : { createTransport: overrides.createTransport }),
    ...(overrides?.now === undefined ? {} : { now: overrides.now }),
  };

  const discovered: DiscoveryResult[] = [];
  for (const config of servers) {
    let excludedToolCount = 0;
    const connection = new McpConnection(config, {
      ...dependencies,
      logger: {
        log(event) {
          if (event.code === "mcp_tools_excluded") {
            excludedToolCount += event.count;
          }
        },
      },
    });
    const startedAt = context.clock.now();
    let connectLatencyMs = 0;
    let protocolEra: DiscoveryResult["protocolEra"] = "unknown";
    let protocolVersion: string | undefined;
    let supportsApps = false;
    let tools: McpTool[] = [];
    let toolCount = 0;
    let reachable = false;
    let errorCode: string | undefined;
    try {
      try {
        await connection.connect();
      } finally {
        connectLatencyMs = Math.max(0, Math.round(context.clock.now() - startedAt));
      }
      protocolEra = connection.protocolEra ?? "unknown";
      const metadata = connection.serverMetadata;
      protocolVersion = metadata.protocolVersion;
      supportsApps = metadata.supportsApps;
      tools = await connection.listTools();
      toolCount = tools.length + excludedToolCount;
      reachable = true;
    } catch (error) {
      toolCount = tools.length + excludedToolCount;
      protocolEra = connection.protocolEra ?? protocolEra;
      const metadata = connection.serverMetadata;
      protocolVersion = metadata.protocolVersion ?? protocolVersion;
      supportsApps = metadata.supportsApps || supportsApps;
      errorCode = error instanceof McpConnectionError ? error.code : "mcp_connect_failed";
    } finally {
      await connection.close();
    }
    discovered.push({
      config,
      protocolEra,
      protocolVersion,
      supportsApps,
      tools,
      excludedToolCount,
      toolCount,
      connectLatencyMs,
      reachable,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }
  return discovered;
}

function createResult(discovered: readonly DiscoveryResult[]) {
  const toolIdsByServer = new Map<Code, Code[]>();
  const rejectedByServer = new Map<Code, { reason: Code }[]>();
  let registryError: Code | undefined;
  const registryInputs = discovered
    .filter(({ reachable }) => reachable)
    .map(({ config, tools }) => ({
      config,
      tools,
    }));

  try {
    const registry = new ToolRegistry(registryInputs);
    for (const spec of registry.getToolSpecs()) {
      const route = registry.resolve(spec.toolId);
      if (route !== undefined) {
        const toolIds = toolIdsByServer.get(route.server.id) ?? [];
        toolIds.push(spec.toolId);
        toolIdsByServer.set(route.server.id, toolIds);
      }
    }
    for (const rejected of registry.rejected()) {
      const rejectedTools = rejectedByServer.get(rejected.serverId) ?? [];
      rejectedTools.push({ reason: rejected.reason });
      rejectedByServer.set(rejected.serverId, rejectedTools);
    }
  } catch (error) {
    registryError = Code.parse(
      error instanceof ToolRegistryError ? error.code : "mcp_registry_failed",
    );
  }

  const servers = discovered.map(
    ({
      config,
      protocolEra,
      protocolVersion,
      supportsApps,
      excludedToolCount,
      toolCount,
      connectLatencyMs,
      reachable,
      errorCode,
    }) => ({
      id: config.id,
      transportKind: config.transport.kind,
      protocolEra,
      protocolVersion: protocolVersionOf(protocolVersion),
      supportsApps,
      trust: config.trust,
      connectLatencyMs,
      reachable,
      toolCount,
      registeredToolIds: toolIdsByServer.get(config.id) ?? [],
      rejectedTools: [
        ...(rejectedByServer.get(config.id) ?? []),
        ...Array.from({ length: excludedToolCount }, () => ({ reason: TOOL_HEADER_INVALID })),
      ],
      ...propagationFor(config),
      warnings: warningsFor(config),
      ...(errorCode === undefined ? {} : { errorCode: Code.parse(errorCode) }),
    }),
  );

  const result = {
    servers,
    ...(registryError === undefined ? {} : { errorCode: registryError }),
  };
  return ServersCheckResultSchema.parse(result);
}

function printHumanResult(
  output: Output,
  result: ReturnType<typeof ServersCheckResultSchema.parse>,
): void {
  const rows: (string | number | boolean)[][] = [
    [
      "id",
      "transport",
      "protocolEra",
      "protocolVersion",
      "apps",
      "trust",
      "connectMs",
      "reachable",
      "toolCount",
      "registeredToolIds",
      "rejectedTools",
      "tracePropagation",
      "traceReason",
      "errorCode",
    ],
  ];
  for (const server of result.servers) {
    rows.push([
      server.id,
      server.transportKind,
      server.protocolEra,
      server.protocolVersion,
      server.supportsApps,
      server.trust,
      server.connectLatencyMs,
      server.reachable,
      server.toolCount,
      server.registeredToolIds.join(","),
      server.rejectedTools.map(({ reason }) => reason).join(","),
      server.tracePropagation,
      server.tracePropagationReason,
      server.errorCode ?? "",
    ]);
    for (const warning of server.warnings) {
      rows.push(["warning", server.id, warning]);
    }
  }
  if (result.errorCode !== undefined) {
    rows.push(["warning", result.errorCode]);
  }
  output.table(rows);
}

function createLoginKeys(config: HarnessConfig, context: CliContext): LocalKeyProvider {
  if (config.keys === undefined) {
    throw new ServersCommandError("key_config_required");
  }
  const resolver = context.secretResolver ?? new CompositeSecretResolver();
  return new LocalKeyProvider({
    config: config.keys,
    secretResolver: { resolve: (reference) => resolver.resolve(reference) },
    env: process.env,
    onWarning: () => undefined,
  });
}

function launchBrowser(url: string): Promise<void> {
  const executable =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => reject(new ServersCommandError("server_browser_open_failed")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function printAuthResult(
  output: Output,
  program: Parameters<CommandModule["register"]>[0],
  result: z.infer<typeof ServerAuthCommandResultSchema>,
): void {
  if (program.optsWithGlobals().json === true) {
    output.json(ServerAuthCommandResultSchema, result);
    return;
  }
  if (result.authorizationUrl !== undefined) {
    output.print(`${result.authorizationUrl}\n`);
  } else {
    output.print(`${result.status}\n`);
  }
}

async function runServersLogin(
  serverId: string,
  options: { readonly open?: boolean },
  program: Parameters<CommandModule["register"]>[0],
  context: CliContext,
  overrides: ServersCommandOverrides | undefined,
): Promise<void> {
  const config = await context.loadConfig();
  const server = config.servers.find(({ id }) => id === serverId);
  if (server === undefined) {
    throw new ServersCommandError("mcp_server_not_found");
  }
  if (
    server.transport.kind !== "http" ||
    server.transport.auth?.grant !== "authorization_code"
  ) {
    throw new McpAuthRequiredError();
  }

  const core = await import("@harness/core");
  const keys = createLoginKeys(config, context);
  let store: OAuthTokenStore | undefined;
  let session: Awaited<ReturnType<typeof startMcpOAuthLogin>> | undefined;
  try {
    store = await OAuthTokenStore.open(
      join(core.resolveDataDir(process.env), "mcp-oauth.db"),
      keys,
    );
    session = await startMcpOAuthLogin({
      server,
      tokenStore: store,
      resolveSecret: async (reference) =>
        (await (context.secretResolver ?? new CompositeSecretResolver()).resolve(reference)).reveal(),
    });
    if (session.authorizationUrl.length > 0) {
      printAuthResult(context.out, program, {
        status: "authorization_required",
        authorizationUrl: session.authorizationUrl,
      });
      if (options.open === true) {
        await (overrides?.openBrowser ?? launchBrowser)(session.authorizationUrl);
      }
    } else {
      printAuthResult(context.out, program, { status: "authorized" });
    }
    await session.complete;
  } catch (error) {
    if (error instanceof ServersCommandError || error instanceof McpAuthRequiredError) {
      throw error;
    }
    throw new McpAuthRequiredError();
  } finally {
    await session?.close();
    store?.close();
    keys.dispose();
  }
}

async function runServersLogout(
  serverId: string,
  program: Parameters<CommandModule["register"]>[0],
  context: CliContext,
): Promise<void> {
  const parsedId = Code.safeParse(serverId);
  if (!parsedId.success) {
    throw new ServersCommandError("mcp_server_not_found");
  }
  const core = await import("@harness/core");
  const keys: KeyProvider = {
    currentKeyId: () => "logout",
    getKey: () => Promise.reject(new OAuthTokenStoreError()),
  };
  const store = await OAuthTokenStore.open(
    join(core.resolveDataDir(process.env), "mcp-oauth.db"),
    keys,
  );
  try {
    store.delete(parsedId.data);
    printAuthResult(context.out, program, { status: "logged_out" });
  } finally {
    store.close();
  }
}

/** Creates the `harness servers check` command. */
export function createServersCommand(overrides?: ServersCommandOverrides): CommandModule {
  return {
    name: "servers",
    register(program, context) {
      const servers = program
        .command("servers")
        .description("Manage configured MCP servers");
      servers
        .command("check")
        .description("Check server connectivity and tool registration")
        .option("--server <id>", "check only the selected server")
        .action(async (options: { readonly server?: string }) => {
          const config: HarnessConfig = await context.loadConfig();
          const configured = config.servers;
          const selected =
            options.server === undefined
              ? configured
              : configured.filter(({ id }) => id === options.server);
          const missingServer = options.server !== undefined && selected.length === 0;
          const discovered = await discoverServers(selected, context, overrides);
          const result = createResult(discovered);
          const completed = {
            ...result,
            ...(missingServer ? { errorCode: Code.parse("mcp_server_not_found") } : {}),
          };
          if (program.optsWithGlobals().json === true) {
            context.out.json(ServersCheckResultSchema, completed);
          } else {
            printHumanResult(context.out, completed);
          }
          if (
            completed.errorCode !== undefined ||
            completed.servers.some(({ reachable }) => !reachable)
          ) {
            throw new ServersCheckFailedError();
          }
        });
      servers
        .command("login")
        .description("Authorize a remote MCP server")
        .argument("<id>", "configured server id")
        .option("--open", "open the authorization URL in a browser")
        .action((id: string, options: { readonly open?: boolean }) =>
          runServersLogin(id, options, program, context, overrides),
        );
      servers
        .command("logout")
        .description("Remove stored OAuth credentials for a server")
        .argument("<id>", "configured server id")
        .action((id: string) => runServersLogout(id, program, context));
    },
  };
}

/** The default command registered by the CLI. */
export const serversCommand = createServersCommand();
