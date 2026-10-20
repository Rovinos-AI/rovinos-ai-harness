// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, type HarnessConfig } from "@harness/config";
import { AkvSecretResolver } from "@harness/vault";
import {
  McpConnection,
  McpConnectionError,
  OAuthTokenStore,
  ToolRegistry,
  ToolRegistryError,
  type McpConnectionDependencies,
  type McpTool,
} from "@harness/mcp";
import { Code, HarnessError, ServersCheckResultSchema, type ServerConfig } from "@harness/schemas";
import type { LocalKeyProvider } from "@harness/vault";
import { join } from "node:path";
import { z } from "zod";
import type { CommandModule } from "../command.js";
import { createLoginKeys, registerServersAuthCommands } from "./servers-auth.js";
import type { Output } from "../output.js";

const MCP_PROTOCOL_VERSION_SCHEMA = z.iso.date();
const APPS_EXTENSION_WARNING = Code.parse("annotations_require_internal");
const TRACE_DISABLED_WARNING = Code.parse("trace_propagation_disabled");
const TOOL_HEADER_INVALID = Code.parse("tool_header_invalid");
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
  oauthTokenStore?: OAuthTokenStore,
): Promise<DiscoveryResult[]> {
  const defaultResolver = new CompositeSecretResolver({ akv: new AkvSecretResolver() });
  const dependencies: McpConnectionDependencies = {
    resolveSecret: async (ref, signal) =>
      context.secretResolver === undefined
        ? (await defaultResolver.resolve(ref, signal)).reveal()
        : (await context.secretResolver.resolve(ref, signal)).reveal(),
    env: process.env,
    ...(oauthTokenStore === undefined ? {} : { oauthTokenStore }),
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
              const core = await import("@harness/core");
              keys = createLoginKeys(config, context);
              store = await OAuthTokenStore.open(
                join(core.resolveDataDir(process.env), "mcp-oauth.db"),
                keys,
              );
            }
            const discovered = await discoverServers(selected, context, overrides, store);
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
