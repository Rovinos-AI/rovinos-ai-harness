// SPDX-License-Identifier: Apache-2.0
import type { Client } from "@modelcontextprotocol/client";

/** Server metadata safe to show in diagnostics. */
export interface McpServerMetadata {
  readonly protocolVersion: string | undefined;
  readonly supportsApps: boolean;
}

/** Returns only the negotiated protocol version and MCP Apps extension presence. */
export function getServerMetadata(client: Client | undefined): McpServerMetadata {
  return {
    protocolVersion: client?.getNegotiatedProtocolVersion(),
    supportsApps:
      client?.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/ui"] !== undefined,
  };
}
