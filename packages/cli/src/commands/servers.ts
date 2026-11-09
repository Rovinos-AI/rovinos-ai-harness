// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, type HarnessConfig } from "@rovinos/config";
import { AkvSecretResolver } from "@rovinos/vault";
import {
  McpConnection,
  McpConnectionError,
  OAuthTokenStore,
  type McpConnectionDependencies,
} from "@rovinos/mcp";
import { Code, HarnessError, ServersCheckResultSchema, type ServerConfig } from "@rovinos/schemas";
import type { LocalKeyProvider } from "@rovinos/vault";
import { join } from "node:path";
import type { CommandModule } from "../command.js";
import { createLoginKeys, registerServersAuthCommands } from "./servers-auth.js";
import {
  createServersCheckResult,
  printServersCheckResult,
  type ServerDiscoveryResult,
} from "./servers-check-report.js";

type ServersCommandOverrides = Pick<McpConnectionDependencies, "createTransport" | "now"> & {
  readonly openBrowser?: (url: string) => Promise<void>;
};

class ServersCheckFailedError extends HarnessError {
  override readonly code = "servers_check_failed";

  constructor() {
    super("servers_check_failed");
  }
}

function unsupportedAppsDiscovery(config: ServerConfig): ServerDiscoveryResult {
  return {
    config,
    protocolEra: "unknown",
    protocolVersion: undefined,
    supportsApps: false,
    supportsTools: false,
    tools: [],
    excludedToolCount: 0,
    toolCount: 0,
    connectLatencyMs: 0,
    connectionAttempted: false,
    connected: false,
    discoverySucceeded: false,
    reachable: false,
    errorCode: "mcp_apps_unsupported",
  };
}

async function discoverServer(
  config: ServerConfig,
  context: Parameters<CommandModule["register"]>[1],
  dependencies: McpConnectionDependencies,
): Promise<ServerDiscoveryResult> {
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
  let protocolEra: ServerDiscoveryResult["protocolEra"] = "unknown";
  let protocolVersion: string | undefined;
  let supportsApps = false;
  let supportsTools = false;
  let tools: ServerDiscoveryResult["tools"] = [];
  let connected = false;
  let discoverySucceeded = false;
  let reachable = false;
  let errorCode: string | undefined;
  try {
    try {
      await connection.connect();
    } finally {
      connectLatencyMs = Math.max(0, Math.round(context.clock.now() - startedAt));
    }
    connected = true;
    protocolEra = connection.protocolEra ?? "unknown";
    const metadata = connection.serverMetadata;
    protocolVersion = metadata.protocolVersion;
    supportsApps = metadata.supportsApps;
    supportsTools = metadata.supportsTools;
    tools = await connection.listTools();
    discoverySucceeded = true;
    reachable = true;
  } catch (error) {
    protocolEra = connection.protocolEra ?? protocolEra;
    const metadata = connection.serverMetadata;
    protocolVersion = metadata.protocolVersion ?? protocolVersion;
    supportsApps = metadata.supportsApps || supportsApps;
    errorCode = error instanceof McpConnectionError ? error.code : "mcp_connect_failed";
  } finally {
    await connection.close();
  }
  const toolCount = tools.length + excludedToolCount;
  return {
    config,
    protocolEra,
    protocolVersion,
    supportsApps,
    supportsTools,
    tools,
    excludedToolCount,
    toolCount,
    connectLatencyMs,
    connectionAttempted: true,
    connected,
    discoverySucceeded,
    reachable,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

async function discoverServers(
  servers: readonly ServerConfig[],
  context: Parameters<CommandModule["register"]>[1],
  overrides: ServersCommandOverrides | undefined,
  oauthTokenStore?: OAuthTokenStore,
): Promise<ServerDiscoveryResult[]> {
  const defaultResolver = new CompositeSecretResolver({ akv: new AkvSecretResolver() });
  const dependencies: McpConnectionDependencies = {
    resolveSecret: async (ref, signal) => {
      const resolver = context.secretResolver ?? defaultResolver;
      return (await resolver.resolve(ref, signal)).reveal();
    },
    env: process.env,
    ...(oauthTokenStore === undefined ? {} : { oauthTokenStore }),
    ...(overrides?.createTransport === undefined
      ? {}
      : { createTransport: overrides.createTransport }),
    ...(overrides?.now === undefined ? {} : { now: overrides.now }),
  };

  const discovered: ServerDiscoveryResult[] = [];
  for (const server of servers) {
    discovered.push(
      server.apps
        ? unsupportedAppsDiscovery(server)
        : await discoverServer(server, context, dependencies),
    );
  }
  return discovered;
}

/** Creates the `harness servers check` command. */
export function createServersCommand(overrides?: ServersCommandOverrides): CommandModule {
  return {
    name: "servers",
    register(program, context) {
      const servers = program.command("servers").description("Manage configured MCP servers");
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
          let keys: LocalKeyProvider | undefined;
          let store: OAuthTokenStore | undefined;
          const hasOAuthServers = selected.some(
            (server) => server.transport.kind === "http" && server.transport.auth !== undefined,
          );
          try {
            if (hasOAuthServers && config.keys !== undefined) {
              const core = await import("@rovinos/core");
              keys = createLoginKeys(config, context);
              store = await OAuthTokenStore.open(
                join(core.resolveDataDir(process.env), "mcp-oauth.db"),
                keys,
              );
            }
            const discovered = await discoverServers(selected, context, overrides, store);
            const result = createServersCheckResult(discovered, missingServer);
            const completed = {
              ...result,
              ...(missingServer ? { errorCode: Code.parse("mcp_server_not_found") } : {}),
            };
            if (program.optsWithGlobals().json === true) {
              context.out.json(ServersCheckResultSchema, completed);
            } else {
              printServersCheckResult(context.out, completed);
            }
            if (
              completed.errorCode !== undefined ||
              completed.servers.some(({ reachable }) => !reachable)
            ) {
              throw new ServersCheckFailedError();
            }
          } finally {
            store?.close();
            keys?.dispose();
          }
        });
      registerServersAuthCommands(servers, program, context, overrides?.openBrowser);
    },
  };
}

/** The default command registered by the CLI. */
export const serversCommand = createServersCommand();
