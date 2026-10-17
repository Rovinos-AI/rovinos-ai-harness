// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { diag } from "@opentelemetry/api";
import { McpConnectionError, McpToolPort, OAuthTokenStore } from "@harness/mcp";
import type { McpLogger } from "@harness/mcp";
import type { LocalKeyProvider } from "@harness/vault";
import type { RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

const diagnosticLogger = diag.createComponentLogger({ namespace: "harness.mcp" });
const mcpLogger: McpLogger = {
  log: (event) => {
    diagnosticLogger.warn(
      event.code,
      event.code === "mcp_stderr"
        ? { serverId: event.serverId, bytes: event.bytes }
        : { serverId: event.serverId },
    );
  },
};

/** Creates the configured MCP tool port and its OAuth store when servers are enabled. */
export async function createConfiguredMcpToolPort(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
  keys: LocalKeyProvider,
  dataDir: string,
): Promise<McpToolPort | undefined> {
  const servers = config.servers ?? [];
  if (overrides.tool !== undefined || servers.length === 0) {
    return undefined;
  }
  const secretResolver = overrides.secretResolver ?? {
    resolve: () => Promise.reject(new McpConnectionError("mcp_connect_failed")),
  };
  const oauthTokenStore = servers.some(
    (server) => server.transport.kind === "http" && server.transport.auth !== undefined,
  )
    ? await OAuthTokenStore.open(join(dataDir, "mcp-oauth.db"), keys)
    : undefined;
  return McpToolPort.create(
    servers,
    {
      resolveSecret: async (ref) => (await secretResolver.resolve(ref)).reveal(),
      logger: mcpLogger,
      ...(oauthTokenStore === undefined ? {} : { oauthTokenStore }),
      ...(overrides.mcpTransportFactory === undefined
        ? {}
        : { createTransport: overrides.mcpTransportFactory }),
    },
    { offloadBinaryResults: overrides.workspace !== undefined },
  );
}
