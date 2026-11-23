// SPDX-License-Identifier: Apache-2.0
import { SdkError, SdkErrorCode, specTypeSchemas, type Client } from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import { McpConnectionError, McpPromptError, McpProtocolError } from "./errors.js";
import { GetPromptResultSchema, ListPromptsResultSchema, listAllPrompts } from "./prompts.js";
import type { GetPromptResult, McpPrompt } from "./prompts.js";
import { runWithSafeAuthLogging } from "./connection-helpers.js";

interface PromptConnectionOptions {
  readonly client: Client;
  readonly config: ServerConfig;
  readonly protocolEra: "legacy" | "modern" | undefined;
  readonly now: () => number;
}

/** Callbacks exposing only the ready client and metadata required by prompt operations. */
export interface PromptConnectionAccess {
  readonly config: ServerConfig;
  readonly client: () => Client | undefined;
  readonly protocolEra: () => "legacy" | "modern" | undefined;
  readonly now: () => number;
  readonly ensureReady: (signal?: AbortSignal) => Promise<void>;
}

/** Performs prompt operations through an already configured MCP connection. */
export class PromptConnection {
  readonly #access: PromptConnectionAccess;

  constructor(access: PromptConnectionAccess) {
    this.#access = access;
  }

  /** Lists server prompts using bounded pagination and server capability checks. */
  list(signal?: AbortSignal): Promise<McpPrompt[]> {
    return this.#run(signal, (client) =>
      listConnectionPrompts(
        {
          client,
          config: this.#access.config,
          protocolEra: this.#access.protocolEra(),
          now: this.#access.now,
        },
        signal,
      ),
    );
  }

  /** Retrieves one prompt with the current advertised arguments. */
  get(
    name: string,
    arguments_: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    return this.#run(signal, (client) =>
      getConnectionPrompt(
        {
          client,
          config: this.#access.config,
          protocolEra: this.#access.protocolEra(),
          now: this.#access.now,
        },
        name,
        arguments_,
        signal,
      ),
    );
  }

  async #run<Result>(
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<Result>,
  ): Promise<Result> {
    try {
      await this.#access.ensureReady(signal);
      const client = this.#access.client();
      if (client === undefined) {
        throw new McpPromptError("mcp_prompt_unavailable");
      }
      return await operation(client);
    } catch (error) {
      throw promptConnectionError(error);
    }
  }
}

function isOAuthConfigured(config: ServerConfig): boolean {
  return config.transport.kind === "http" && config.transport.auth !== undefined;
}

function onLegacyAbort(
  client: Client,
  protocolEra: PromptConnectionOptions["protocolEra"],
): () => void {
  return () => {
    if (protocolEra === "legacy") {
      void client.close().catch(() => undefined);
    }
  };
}

/** Lists server prompts using bounded pagination and server capability checks. */
export async function listConnectionPrompts(
  options: PromptConnectionOptions,
  signal?: AbortSignal,
): Promise<McpPrompt[]> {
  const { client, config } = options;
  try {
    if (client.getServerCapabilities()?.prompts === undefined) {
      throw new McpPromptError("mcp_prompt_unavailable");
    }
    return await runWithSafeAuthLogging(isOAuthConfigured(config), () =>
      listAllPrompts({
        now: options.now,
        ...(signal === undefined ? {} : { signal }),
        requestPage: async (cursor, requestSignal) => {
          const handleAbort = onLegacyAbort(client, options.protocolEra);
          requestSignal.addEventListener("abort", handleAbort, { once: true });
          try {
            const result = await client.request(
              {
                method: "prompts/list",
                ...(cursor === undefined ? {} : { params: { cursor } }),
              },
              specTypeSchemas.ListPromptsResult,
              { timeout: config.timeouts.callMs, signal: requestSignal },
            );
            return ListPromptsResultSchema.parse(result);
          } catch (error) {
            handleAbort();
            throw error;
          } finally {
            requestSignal.removeEventListener("abort", handleAbort);
          }
        },
      }),
    );
  } catch (error) {
    throw promptConnectionError(error);
  }
}

/** Retrieves a prompt result on the already selected server connection. */
export async function getConnectionPrompt(
  options: PromptConnectionOptions,
  name: string,
  arguments_: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<GetPromptResult> {
  const { client, config } = options;
  try {
    if (client.getServerCapabilities()?.prompts === undefined) {
      throw new McpPromptError("mcp_prompt_unavailable");
    }
    const handleAbort = onLegacyAbort(client, options.protocolEra);
    signal?.addEventListener("abort", handleAbort, { once: true });
    const result = await runWithSafeAuthLogging(isOAuthConfigured(config), async () => {
      try {
        return await client.request(
          {
            method: "prompts/get",
            params: {
              name,
              ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
            },
          },
          specTypeSchemas.GetPromptResult,
          {
            timeout: config.timeouts.callMs,
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch (error) {
        handleAbort();
        throw error;
      } finally {
        signal?.removeEventListener("abort", handleAbort);
      }
    });
    return GetPromptResultSchema.parse(result);
  } catch (error) {
    throw promptConnectionError(error);
  }
}

/** Converts server and SDK failures to the closed prompt error surface. */
export function promptConnectionError(error: unknown): McpPromptError {
  if (error instanceof McpPromptError) {
    return error;
  }
  if (error instanceof McpConnectionError && error.code === "mcp_response_too_large") {
    return new McpPromptError("mcp_prompt_result_too_large");
  }
  if (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion)
  ) {
    return new McpPromptError("mcp_prompt_unavailable");
  }
  if (error instanceof McpProtocolError && error.protocolCode === -32601) {
    return new McpPromptError("mcp_prompt_unavailable");
  }
  return new McpPromptError("mcp_prompt_failed");
}
