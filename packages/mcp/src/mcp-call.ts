// SPDX-License-Identifier: Apache-2.0
import {
  ProtocolError,
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Client,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import { McpProtocolError } from "./errors.js";
import { buildActiveRequestMeta } from "./trace-injection.js";
import type { McpTool } from "./tool-list.js";
import { toWireInputResponses, type ElicitationRetry } from "./elicitation/mrtr.js";

/**
 * Calls a discovered tool with request metadata and its discovered definition.
 *
 * @param client - Connected SDK client.
 * @param server - Validated configuration for the target server.
 * @param params - Native tool name, arguments, and optional request metadata.
 * @param options - SDK request options such as cancellation.
 * @param toolDefinition - Discovered tool definition used for header mapping.
 * @returns The remote tool result.
 */
export async function invokeMcpTool(options: {
  readonly client: Pick<Client, "callTool">;
  readonly server: ServerConfig;
  readonly params: CallToolRequest["params"];
  readonly requestOptions?: CallToolRequestOptions;
  readonly toolDefinition?: McpTool;
  readonly inputRetry?: ElicitationRetry;
}): Promise<CallToolResult> {
  const { _meta: existingMeta, ...callParams } = options.params;
  const requestMeta = buildActiveRequestMeta(options.server, existingMeta);
  const clientCapabilities = Object.fromEntries(
    Object.entries(requestMeta ?? {}).filter(([key]) => key !== CLIENT_CAPABILITIES_META_KEY),
  );
  if (options.server.elicitation.enabled) {
    clientCapabilities[CLIENT_CAPABILITIES_META_KEY] = {
      elicitation: Object.fromEntries(options.server.elicitation.modes.map((mode) => [mode, {}])),
    };
  }
  try {
    return await options.client.callTool(
      {
        ...callParams,
        ...(options.inputRetry === undefined || options.inputRetry.source === "mcp_legacy"
          ? {}
          : {
              inputResponses: toWireInputResponses(options.inputRetry.inputResponses),
              ...(options.inputRetry.requestState === undefined
                ? {}
                : { requestState: options.inputRetry.requestState }),
            }),
        ...(Object.keys(clientCapabilities).length === 0 ? {} : { _meta: clientCapabilities }),
      },
      {
        timeout: options.server.timeouts.callMs,
        allowInputRequired: true,
        ...(options.toolDefinition === undefined ? {} : { toolDefinition: options.toolDefinition }),
        ...options.requestOptions,
      },
    );
  } catch (error) {
    if (error instanceof UrlElicitationRequiredError) {
      throw new McpProtocolError(error.code, error.elicitations);
    }
    if (error instanceof ProtocolError) {
      throw new McpProtocolError(error.code);
    }
    throw error;
  }
}
