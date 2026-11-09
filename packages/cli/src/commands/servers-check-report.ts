// SPDX-License-Identifier: Apache-2.0
import { ToolRegistry, ToolRegistryError, type McpTool } from "@rovinos/mcp";
import { Code, ServersCheckResultSchema } from "@rovinos/schemas";
import type {
  ServerConfig,
  ServersCheckPhase,
  ServersCheckPhases,
  ServersCheckResult,
  ServersCheckServerResult,
} from "@rovinos/schemas";
import type { Output } from "../output.js";
import { z } from "zod";

const TOOL_HEADER_INVALID = Code.parse("tool_header_invalid");
const MCP_PROTOCOL_VERSION_SCHEMA = z.iso.date();

/** Result of one safe connection and tool-discovery attempt. */
export interface ServerDiscoveryResult {
  readonly config: ServerConfig;
  readonly protocolEra: "legacy" | "modern" | "unknown";
  readonly protocolVersion: string | undefined;
  readonly supportsApps: boolean;
  readonly supportsTools: boolean;
  readonly tools: readonly McpTool[];
  readonly excludedToolCount: number;
  readonly toolCount: number;
  readonly connectLatencyMs: number;
  readonly connectionAttempted: boolean;
  readonly connected: boolean;
  readonly discoverySucceeded: boolean;
  readonly reachable: boolean;
  readonly errorCode?: string;
}

function protocolVersionOf(version: string | undefined): string {
  return version !== undefined && MCP_PROTOCOL_VERSION_SCHEMA.safeParse(version).success
    ? version
    : "unknown";
}

function phase(status: ServersCheckPhase["status"], errorCode?: Code): ServersCheckPhase {
  return errorCode === undefined ? { status } : { status, errorCode };
}

function capabilityStatus(connected: boolean, supported: boolean): "yes" | "no" | "unknown" {
  if (!connected) {
    return "unknown";
  }
  return supported ? "yes" : "no";
}

function propagationFor(server: ServerConfig): {
  readonly tracePropagation: "yes" | "no";
  readonly tracePropagationReason: "external" | "disabled" | "enabled";
} {
  if (server.trust === "external") {
    return { tracePropagation: "no", tracePropagationReason: "external" };
  }
  if (server.propagateTrace) {
    return { tracePropagation: "yes", tracePropagationReason: "enabled" };
  }
  return { tracePropagation: "no", tracePropagationReason: "disabled" };
}

function warningsFor(server: ServerConfig): Code[] {
  const warnings: Code[] = [];
  if (server.trust === "internal" && !server.propagateTrace) {
    warnings.push(Code.parse("trace_propagation_disabled"));
  }
  if (server.trust === "external" && server.useAnnotations) {
    warnings.push(Code.parse("annotations_require_internal"));
  }
  return warnings;
}

function connectionPhase(entry: ServerDiscoveryResult): ServersCheckPhase {
  if (!entry.connectionAttempted) {
    return phase("not_tested");
  }
  if (!entry.connected) {
    return phase("failed", entry.errorCode === undefined ? undefined : Code.parse(entry.errorCode));
  }
  return phase("success");
}

function authenticationPhase(entry: ServerDiscoveryResult): ServersCheckPhase {
  if (entry.errorCode === "mcp_auth_required") {
    return phase("failed", Code.parse(entry.errorCode));
  }
  if (entry.config.transport.kind !== "http") {
    return phase("not_applicable");
  }
  const headersConfigured =
    entry.config.transport.headers !== undefined &&
    Object.keys(entry.config.transport.headers).length > 0;
  const oauthConfigured = entry.config.transport.auth !== undefined;
  if (!headersConfigured && !oauthConfigured) {
    return phase("not_applicable");
  }
  if (oauthConfigured && entry.connected) {
    return phase("success");
  }
  return phase("not_tested");
}

function negotiationPhase(entry: ServerDiscoveryResult): ServersCheckPhase {
  return phase(entry.connected ? "success" : "not_tested");
}

function discoveryPhase(entry: ServerDiscoveryResult): ServersCheckPhase {
  if (!entry.connected) {
    return phase("not_tested");
  }
  if (entry.discoverySucceeded) {
    return phase("success");
  }
  return phase("failed", entry.errorCode === undefined ? undefined : Code.parse(entry.errorCode));
}

function schemaValidationPhase(
  entry: ServerDiscoveryResult,
  acceptedToolCount: number,
  rejectedTools: readonly { readonly reason: Code }[],
): ServersCheckPhase {
  if (!entry.discoverySucceeded) {
    return phase("not_tested");
  }
  const schemaRejection = rejectedTools.find(
    ({ reason }) => reason === "tool_schema_too_large" || reason === "tool_schema_unsupported",
  );
  if (schemaRejection !== undefined) {
    return phase(acceptedToolCount > 0 ? "partial" : "failed", schemaRejection.reason);
  }
  if (rejectedTools.length > 0) {
    return phase(acceptedToolCount > 0 ? "partial" : "not_tested");
  }
  return phase("success");
}

function exposurePhase(
  entry: ServerDiscoveryResult,
  rejectedTools: readonly { readonly reason: Code }[],
  registryError: Code | undefined,
): ServersCheckPhase {
  if (!entry.discoverySucceeded) {
    return phase("not_tested");
  }
  if (registryError !== undefined) {
    return phase("failed", registryError);
  }
  return phase(rejectedTools.length > 0 ? "partial" : "success");
}

function phasesFor(
  entry: ServerDiscoveryResult,
  acceptedToolCount: number,
  rejectedTools: readonly { readonly reason: Code }[],
  registryError: Code | undefined,
): ServersCheckPhases {
  return {
    connection: connectionPhase(entry),
    authentication: authenticationPhase(entry),
    negotiation: negotiationPhase(entry),
    discovery: discoveryPhase(entry),
    schemaValidation: schemaValidationPhase(entry, acceptedToolCount, rejectedTools),
    exposure: exposurePhase(entry, rejectedTools, registryError),
    policyConfiguration: {
      status: "not_tested",
      allowlistConfigured: entry.config.toolAllowlist !== undefined,
    },
  };
}

function nextActionFor(
  entry: ServerDiscoveryResult,
  excludedToolCount: number,
  rejectedTools: readonly { readonly reason: Code }[],
  registryError: Code | undefined,
):
  | "none"
  | "configure_authentication"
  | "check_transport_configuration"
  | "retry_discovery"
  | "review_server_configuration"
  | "review_tool_configuration"
  | "review_tool_allowlist" {
  if (entry.errorCode === "mcp_apps_unsupported") {
    return "review_server_configuration";
  }
  if (entry.errorCode === "mcp_auth_required") {
    return "configure_authentication";
  }
  if (!entry.connected) {
    return "check_transport_configuration";
  }
  if (!entry.discoverySucceeded) {
    return "retry_discovery";
  }
  if (
    registryError !== undefined ||
    rejectedTools.some(({ reason }) => reason !== "tool_not_allowlisted")
  ) {
    return "review_tool_configuration";
  }
  if (excludedToolCount > 0) {
    return "review_tool_allowlist";
  }
  return "none";
}

function serverResult(
  entry: ServerDiscoveryResult,
  toolIdsByServer: ReadonlyMap<Code, Code[]>,
  rejectedByServer: ReadonlyMap<Code, { readonly reason: Code }[]>,
  registryError: Code | undefined,
) {
  const registeredToolIds = toolIdsByServer.get(entry.config.id) ?? [];
  const rejectedTools = [
    ...(rejectedByServer.get(entry.config.id) ?? []),
    ...Array.from({ length: entry.excludedToolCount }, () => ({ reason: TOOL_HEADER_INVALID })),
  ];
  const excludedToolCount =
    registryError !== undefined && entry.discoverySucceeded
      ? entry.toolCount
      : rejectedTools.length;

  return {
    id: entry.config.id,
    transportKind: entry.config.transport.kind,
    protocolEra: entry.protocolEra,
    protocolVersion: protocolVersionOf(entry.protocolVersion),
    supportsApps: entry.supportsApps,
    capabilities: {
      apps: capabilityStatus(entry.connected, entry.supportsApps),
      tools: capabilityStatus(entry.connected, entry.supportsTools),
    },
    trust: entry.config.trust,
    connectLatencyMs: entry.connectLatencyMs,
    reachable: entry.reachable,
    toolCount: entry.toolCount,
    acceptedToolCount: registeredToolIds.length,
    excludedToolCount,
    registeredToolIds,
    rejectedTools,
    phases: phasesFor(entry, registeredToolIds.length, rejectedTools, registryError),
    aliasMappingAvailable: false,
    nextAction: nextActionFor(entry, excludedToolCount, rejectedTools, registryError),
    ...propagationFor(entry.config),
    warnings: warningsFor(entry.config),
    ...(entry.errorCode === undefined ? {} : { errorCode: Code.parse(entry.errorCode) }),
  };
}

function catalogResult(
  entries: readonly ServerDiscoveryResult[],
  incomplete: boolean,
  registryError: Code | undefined,
  catalogFingerprint: string | undefined,
): {
  readonly catalogFingerprintStatus: "complete" | "partial" | "not_tested";
  readonly catalogFingerprint?: string;
} {
  const complete =
    !incomplete &&
    registryError === undefined &&
    entries.every(({ discoverySucceeded }) => discoverySucceeded);
  if (complete && catalogFingerprint !== undefined) {
    return { catalogFingerprintStatus: "complete", catalogFingerprint };
  }
  if (entries.some(({ discoverySucceeded }) => discoverySucceeded)) {
    return { catalogFingerprintStatus: "partial" };
  }
  return { catalogFingerprintStatus: "not_tested" };
}

/** Builds the validated, metadata-only report for the servers check. */
export function createServersCheckResult(
  entries: readonly ServerDiscoveryResult[],
  incomplete = false,
): ServersCheckResult {
  const toolIdsByServer = new Map<Code, Code[]>();
  const rejectedByServer = new Map<Code, { reason: Code }[]>();
  let registryError: Code | undefined;
  let catalogFingerprint: string | undefined;
  const registryInputs = entries
    .filter(({ reachable }) => reachable)
    .map(({ config, tools }) => ({ config, tools }));

  try {
    const registry = new ToolRegistry(registryInputs);
    catalogFingerprint = registry.catalogVersion;
    for (const spec of registry.getToolSpecs()) {
      const route = registry.resolve(spec.toolId);
      if (route === undefined) {
        continue;
      }
      const toolIds = toolIdsByServer.get(route.server.id) ?? [];
      toolIds.push(spec.toolId);
      toolIdsByServer.set(route.server.id, toolIds);
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

  const catalog = catalogResult(entries, incomplete, registryError, catalogFingerprint);
  return ServersCheckResultSchema.parse({
    reportVersion: 1,
    ...catalog,
    servers: entries.map((entry) =>
      serverResult(entry, toolIdsByServer, rejectedByServer, registryError),
    ),
    ...(registryError === undefined ? {} : { errorCode: registryError }),
  });
}

type ServersCheckReportServer = ServersCheckServerResult;

function serverRow(server: ServersCheckReportServer): (string | number | boolean)[] {
  return [
    server.id,
    server.transportKind,
    server.protocolEra,
    server.protocolVersion,
    server.supportsApps,
    `apps=${server.capabilities.apps},tools=${server.capabilities.tools}`,
    server.trust,
    server.connectLatencyMs,
    server.reachable,
    server.toolCount,
    server.acceptedToolCount,
    server.excludedToolCount,
    server.registeredToolIds.join(","),
    server.rejectedTools.map(({ reason }) => reason).join(","),
    Object.entries(server.phases)
      .map(([name, value]) => `${name}=${value.status}`)
      .join(","),
    server.aliasMappingAvailable,
    server.nextAction,
    server.tracePropagation,
    server.tracePropagationReason,
    server.errorCode ?? "",
  ];
}

/** Prints the safe human-readable view of a validated report. */
export function printServersCheckResult(
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
      "capabilities",
      "trust",
      "connectMs",
      "reachable",
      "toolCount",
      "acceptedToolCount",
      "excludedToolCount",
      "registeredToolIds",
      "rejectedTools",
      "phases",
      "aliasMappingAvailable",
      "nextAction",
      "tracePropagation",
      "traceReason",
      "errorCode",
    ],
    [
      "report",
      result.reportVersion,
      result.catalogFingerprintStatus,
      result.catalogFingerprint ?? "",
    ],
  ];
  for (const server of result.servers) {
    rows.push(serverRow(server));
    for (const warning of server.warnings) {
      rows.push(["warning", server.id, warning]);
    }
  }
  if (result.errorCode !== undefined) {
    rows.push(["warning", result.errorCode]);
  }
  output.table(rows);
}
