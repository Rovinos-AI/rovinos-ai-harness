// SPDX-License-Identifier: Apache-2.0
// Onboarding registers no tools by default; exposure never grants execution authority.
import { HarnessConfigSchema, type HarnessConfig } from "@rovinos/config";
import {
  McpConnection,
  McpConnectionError,
  McpAuthRequiredError,
  ToolRegistry,
  ToolRegistryError,
  type McpConnectionDependencies,
} from "@rovinos/mcp";
import {
  Code,
  JsonValue,
  ServerConfigSchema,
  Sha256Hex,
  type SecretRef,
  type ServerConfig,
} from "@rovinos/schemas";
import { z } from "zod";
import { SdkError } from "./types.js";

const McpCatalogToolSchema = z
  .object({
    name: z.string().min(1),
    toolId: Code,
    description: z.string(),
    inputSchema: JsonValue,
    exposed: z.boolean(),
  })
  .strict();

const McpCatalogRejectionSchema = z.object({ reason: Code }).strict();

/** Complete, validated view of one discovered MCP server catalog. */
export const McpCatalogInspectionSchema = z
  .object({
    serverId: Code,
    catalogVersion: Sha256Hex,
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    tools: z.array(McpCatalogToolSchema),
    rejectedTools: z.array(McpCatalogRejectionSchema),
  })
  .strict();

/** Inferred catalog inspection returned by {@link inspectMcpServer}. */
export type McpCatalogInspection = z.infer<typeof McpCatalogInspectionSchema>;

/** Typed MCP server configuration accepted by {@link registerMcpServer}. */
export type McpServerConfig = z.input<typeof ServerConfigSchema>;

const abortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function",
);

const secretResolverSchema = z.custom<(ref: SecretRef, signal?: AbortSignal) => Promise<string>>(
  (value) => typeof value === "function",
);

/** Dependencies needed to resolve references during a read-only server inspection. */
export const InspectMcpServerOptionsSchema = z
  .object({
    resolveSecret: secretResolverSchema,
    signal: abortSignalSchema.optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
  })
  .strict();

/** Inferred options accepted by {@link inspectMcpServer}. */
export type InspectMcpServerOptions = z.infer<typeof InspectMcpServerOptionsSchema>;

/** Exact tools selected for model exposure; execution still follows configured policy. */
export const McpToolSelectionSchema = z
  .object({
    serverId: Code,
    catalogVersion: Sha256Hex,
    tools: z.array(z.object({ name: z.string().min(1), toolId: Code }).strict()),
    authorization: z.literal("policy_unchanged"),
  })
  .strict();

/** Inferred explicit tool exposure preview returned by {@link selectMcpTools}. */
export type McpToolSelection = z.infer<typeof McpToolSelectionSchema>;

/** Configuration and exact exposure preview returned by {@link selectMcpTools}. */
export interface McpToolSelectionResult {
  readonly config: HarnessConfig;
  readonly selection: McpToolSelection;
}

function parseHarnessConfig(value: unknown): HarnessConfig {
  const parsed = HarnessConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new SdkError("sdk_mcp_config_invalid");
  }
  return parsed.data;
}

function parseServerConfig(value: unknown): ServerConfig {
  const parsed = ServerConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new SdkError("sdk_mcp_config_invalid");
  }
  return parsed.data;
}

/**
 * Adds a validated MCP server to a configuration without changing a running harness.
 *
 * A server is registered with an empty tool allowlist by default. Supply an explicit allowlist
 * only when those tools should be exposed to the model; policy remains a separate authorization
 * decision.
 *
 * @param config - Existing harness configuration.
 * @param server - New MCP server configuration, containing secret references rather than values.
 * @returns A validated configuration with the server registered.
 * @throws SdkError when the configuration is invalid or the server id already exists.
 */
export function registerMcpServer(
  config: z.input<typeof HarnessConfigSchema>,
  server: McpServerConfig,
): HarnessConfig {
  const parsedConfig = parseHarnessConfig(config);
  const parsedServer = parseServerConfig({
    ...server,
    toolAllowlist: server.toolAllowlist ?? [],
  });
  if (parsedConfig.servers.some(({ id }) => id === parsedServer.id)) {
    throw new SdkError("sdk_mcp_server_exists");
  }
  return parseHarnessConfig({ ...parsedConfig, servers: [...parsedConfig.servers, parsedServer] });
}

/**
 * Connects to one configured server and returns its validated candidate catalog.
 *
 * Discovery is read-only and does not execute tools. The returned descriptions and schemas are
 * untrusted server content. Selection is based on server-native tool names; allowlist policy is
 * reported separately from the harness policy that authorizes execution.
 *
 * @param server - Validated or typed MCP server configuration.
 * @param options - Secret-reference resolver and optional cancellation/environment adapters.
 * @returns A sanitized, schema-validated catalog and its fingerprint.
 * @throws SdkError with a closed code when connection or catalog validation fails.
 */
export async function inspectMcpServer(
  server: McpServerConfig,
  options: InspectMcpServerOptions,
): Promise<McpCatalogInspection> {
  const config = parseServerConfig(server);
  const parsedDependencies = InspectMcpServerOptionsSchema.safeParse(options);
  if (!parsedDependencies.success) {
    throw new SdkError("sdk_mcp_inspection_options_invalid");
  }
  const dependencies = parsedDependencies.data;
  const unfilteredConfig = ServerConfigSchema.parse({
    ...config,
    toolAllowlist: undefined,
    idempotentTools: undefined,
  });
  const connectionDependencies: McpConnectionDependencies = {
    resolveSecret: async (ref, signal) => {
      try {
        return await dependencies.resolveSecret(ref, signal);
      } catch {
        throw new McpConnectionError("mcp_connect_failed");
      }
    },
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
  };
  const connection = new McpConnection(unfilteredConfig, connectionDependencies);
  try {
    await connection.connect(dependencies.signal);
    const tools = await connection.listTools(dependencies.signal);
    const registry = new ToolRegistry([{ config: unfilteredConfig, tools }]);
    const catalogTools = registry.getToolSpecs().flatMap((spec) => {
      const route = registry.resolve(spec.toolId);
      if (route === undefined) {
        return [];
      }
      return [
        {
          name: route.nativeName,
          toolId: spec.toolId,
          description: spec.description,
          inputSchema: route.inputSchema,
          exposed:
            config.toolAllowlist === undefined || config.toolAllowlist.includes(route.nativeName),
        },
      ];
    });
    return McpCatalogInspectionSchema.parse({
      serverId: config.id,
      catalogVersion: registry.catalogVersion,
      ...(connection.protocolEra === undefined ? {} : { protocolEra: connection.protocolEra }),
      tools: catalogTools,
      rejectedTools: registry.rejected().map(({ reason }) => ({ reason })),
    });
  } catch (error) {
    if (error instanceof McpConnectionError) {
      throw new SdkError(error.code);
    }
    if (error instanceof McpAuthRequiredError) {
      throw new SdkError("mcp_auth_required");
    }
    if (error instanceof ToolRegistryError) {
      throw new SdkError("sdk_mcp_catalog_invalid");
    }
    throw new SdkError("sdk_mcp_inspection_failed");
  } finally {
    await connection.close();
  }
}

/**
 * Selects discovered server-native tool names for model exposure without changing execution policy.
 *
 * Newly registered servers default to no exposed tools. Selection must come from the inspected
 * catalog; every selected call still passes through the configured allow/ask/deny policy.
 *
 * @param config - Existing harness configuration.
 * @param inspection - The catalog inspection used to review the available tools.
 * @param toolNames - Exact server-native names to expose; an empty list exposes none.
 * @returns The updated validated configuration and an exact selection preview.
 * @throws SdkError when the server or any selected tool is not in the reviewed catalog.
 */
export function selectMcpTools(
  config: z.input<typeof HarnessConfigSchema>,
  inspection: McpCatalogInspection,
  toolNames: readonly string[],
): McpToolSelectionResult {
  const parsedConfig = parseHarnessConfig(config);
  const parsedInspection = McpCatalogInspectionSchema.safeParse(inspection);
  if (!parsedInspection.success) {
    throw new SdkError("sdk_mcp_catalog_invalid");
  }
  const parsedNames = z.array(z.string().min(1)).safeParse(toolNames);
  if (!parsedNames.success || new Set(parsedNames.data).size !== parsedNames.data.length) {
    throw new SdkError("sdk_mcp_selection_invalid");
  }
  const server = parsedConfig.servers.find(({ id }) => id === parsedInspection.data.serverId);
  if (server === undefined) {
    throw new SdkError("sdk_mcp_server_not_found");
  }
  const selected = new Set(parsedNames.data);
  const catalogNames = new Set(parsedInspection.data.tools.map(({ name }) => name));
  if ([...selected].some((name) => !catalogNames.has(name))) {
    throw new SdkError("sdk_mcp_tool_not_found");
  }
  const orderedTools = parsedInspection.data.tools.filter(({ name }) => selected.has(name));
  const updatedConfig = parseHarnessConfig({
    ...parsedConfig,
    servers: parsedConfig.servers.map((entry) =>
      entry.id !== server.id
        ? entry
        : {
            ...entry,
            toolAllowlist: orderedTools.map(({ name }) => name),
            idempotentTools: (entry.idempotentTools ?? []).filter((name) => selected.has(name)),
          },
    ),
  });
  return {
    config: updatedConfig,
    selection: McpToolSelectionSchema.parse({
      serverId: server.id,
      catalogVersion: parsedInspection.data.catalogVersion,
      tools: orderedTools.map(({ name, toolId }) => ({ name, toolId })),
      authorization: "policy_unchanged",
    }),
  };
}
