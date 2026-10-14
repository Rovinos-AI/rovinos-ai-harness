// SPDX-License-Identifier: Apache-2.0
import {
  ProtocolError,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Client,
} from "@modelcontextprotocol/client";
import type { ServerConfig } from "@harness/schemas";
import { McpProtocolError } from "./errors.js";
import { buildActiveRequestMeta } from "./trace-injection.js";
import type { McpTool } from "./tool-list.js";

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
  readonly client: Client;
  readonly server: ServerConfig;
  readonly params: CallToolRequest["params"];
  readonly requestOptions?: CallToolRequestOptions;
  readonly toolDefinition?: McpTool;
}): Promise<CallToolResult> {
  const { _meta: existingMeta, ...callParams } = options.params;
  const requestMeta = buildActiveRequestMeta(options.server, existingMeta);
  try {
    return await options.client.callTool(
      {
        ...callParams,
        ...(requestMeta === undefined ? {} : { _meta: requestMeta }),
      },
      {
        timeout: options.server.timeouts.callMs,
        allowInputRequired: true,
        ...(options.toolDefinition === undefined
          ? {}
          : { toolDefinition: options.toolDefinition }),
        ...options.requestOptions,
      },
    );
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw new McpProtocolError(error.code);
    }
    throw error;
  }
}
