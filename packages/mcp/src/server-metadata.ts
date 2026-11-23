// SPDX-License-Identifier: Apache-2.0
import type { Client } from "@modelcontextprotocol/client";

/** Server metadata safe to show in diagnostics. */
export interface McpServerMetadata {
  readonly protocolVersion: string | undefined;
  readonly supportsApps: boolean;
  readonly supportsTools: boolean;
  readonly supportsPrompts: boolean;
}

/** Returns the negotiated protocol version and advertised server capabilities. */
export function getServerMetadata(client: Client | undefined): McpServerMetadata {
  const capabilities = client?.getServerCapabilities();
  return {
    protocolVersion: client?.getNegotiatedProtocolVersion(),
    supportsApps: capabilities?.extensions?.["io.modelcontextprotocol/ui"] !== undefined,
    supportsTools: capabilities?.tools !== undefined,
    supportsPrompts: capabilities?.prompts !== undefined,
  };
}
