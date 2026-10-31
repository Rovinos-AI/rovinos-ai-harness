// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  specTypeSchemas,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { compileJsonSchema, type ServerConfig } from "@rovinos/schemas";
import type { ElicitationRetry } from "./elicitation/mrtr.js";
import { McpConnectionError } from "./errors.js";
import { invokeMcpTool } from "./mcp-call.js";
import type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
import { withOAuthWarningsRedacted } from "./oauth/provider.js";
import type { McpOAuthProvider } from "./oauth/provider.js";
import {
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  resourceAdvertisesClientCredentials,
} from "./oauth/protected-resource.js";
import type { McpTool } from "./tool-list.js";
import { createMcpTransport } from "./transports.js";

export { OAUTH_CLIENT_CREDENTIALS_EXTENSION } from "./oauth/protected-resource.js";
export const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000] as const;
export const ListToolsResultSchema = specTypeSchemas.ListToolsResult;

/** Reconnects with bounded backoff while preserving close and cancellation failures. */
export async function reconnectWithBackoff(options: {
  readonly isClosed: () => boolean;
  readonly signal: AbortSignal | undefined;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly connect: (signal: AbortSignal | undefined) => Promise<void>;
}): Promise<void> {
  const assertMayReconnect = (): void => {
    if (options.isClosed()) {
      throw new McpConnectionError("mcp_connection_lost");
    }
    if (options.signal?.aborted === true) {
      throw new McpConnectionError("mcp_connect_timeout");
    }
  };
  let lastError: unknown;
  for (const delay of RECONNECT_BACKOFF_MS) {
    assertMayReconnect();
    await options.sleep(delay);
    assertMayReconnect();
    try {
      await options.connect(options.signal);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof McpConnectionError
    ? lastError
    : new McpConnectionError("mcp_connect_failed");
}

/** A cached tool list together with its expiration time. */
export interface CachedToolList {
  readonly tools: readonly McpTool[];
  readonly expiresAt: number;
}

const schemaValidatorCache = new WeakMap<Record<string, unknown>, (value: unknown) => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a cached JSON Schema validator for an MCP tool input schema. */
export function getOrCreateValidator(inputSchema: unknown): (value: unknown) => void {
  if (!isRecord(inputSchema)) {
    return compileJsonSchema(inputSchema);
  }
  const cached = schemaValidatorCache.get(inputSchema);
  if (cached !== undefined) {
    return cached;
  }
  const validator = compileJsonSchema(inputSchema);
  schemaValidatorCache.set(inputSchema, validator);
  return validator;
}

/** Sleeps for the given duration. */
export const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Converts the configured protocol selection to SDK transport options. */
export function protocolOptions(
  protocol: ServerConfig["protocol"],
): { readonly mode: "auto" | "legacy" } | { readonly mode: { readonly pin: "2026-07-28" } } {
  if (protocol === "auto") {
    return { mode: "auto" as const };
  }
  if (protocol === "2026-07-28") {
    return { mode: { pin: protocol } };
  }
  return { mode: "legacy" as const };
}

/** Runs an SDK operation with auth-path warning output suppressed when OAuth is configured. */
export function runWithSafeAuthLogging<Result>(
  oauthConfigured: boolean,
  operation: () => Promise<Result>,
): Promise<Result> {
  return oauthConfigured ? withOAuthWarningsRedacted(operation) : operation();
}

/** Invokes a validated tool call with connection state and OAuth warning handling. */
export function invokeConnectionTool(options: {
  readonly config: ServerConfig;
  readonly client: Client | undefined;
  readonly state: McpConnectionState;
  readonly params: CallToolRequest["params"];
  readonly requestOptions?: CallToolRequestOptions;
  readonly toolDefinition?: McpTool;
  readonly inputRetry?: ElicitationRetry;
}): Promise<CallToolResult> {
  const client = options.client;
  if (client === undefined || options.state !== "ready") {
    throw new McpConnectionError("mcp_connection_lost");
  }
  return runWithSafeAuthLogging(
    options.config.transport.kind === "http" && options.config.transport.auth !== undefined,
    () =>
      invokeMcpTool({
        client,
        server: options.config,
        params: options.params,
        ...(options.requestOptions === undefined ? {} : { requestOptions: options.requestOptions }),
        ...(options.toolDefinition === undefined ? {} : { toolDefinition: options.toolDefinition }),
        ...(options.inputRetry === undefined ? {} : { inputRetry: options.inputRetry }),
      }),
  );
}

/** Detects client-credentials extension support before initialize can trigger OAuth. */
export async function clientCredentialsExtensionAvailable(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<boolean> {
  return config.transport.kind === "http" && config.transport.auth?.grant === "client_credentials"
    ? resourceAdvertisesClientCredentials(config.transport.url, signal)
    : false;
}

/** Retains client-credentials extension support across reconnects. */
export class ClientCredentialsExtensionSupport {
  #supported = false;
  #probe: Promise<boolean> | undefined;

  /** Whether the extension has been advertised by the resource or MCP server. */
  get supported(): boolean {
    return this.#supported;
  }

  /** Records support advertised by the initialized MCP server. */
  observe(supported: boolean): void {
    this.#supported ||= supported;
  }

  /** Probes resource metadata before initialize can trigger OAuth. */
  async probe(config: ServerConfig, signal: AbortSignal, skip: boolean): Promise<void> {
    if (skip || this.#supported) {
      return;
    }
    const probe = (this.#probe ??= clientCredentialsExtensionAvailable(config, signal));
    try {
      this.#supported ||= await probe;
    } catch (error) {
      if (this.#probe === probe) {
        this.#probe = undefined;
      }
      if (signal.aborted) {
        throw error;
      }
    }
  }
}

/** Creates the configured transport and reports the OAuth provider selected for HTTP auth. */
export function createConfiguredTransport(
  config: ServerConfig,
  dependencies: McpConnectionDependencies,
  options: {
    readonly clientCredentialsExtensionEnabled: boolean;
    readonly onOAuthProvider: (provider: McpOAuthProvider) => void;
    readonly signal: AbortSignal;
  },
): Promise<Transport> | Transport {
  if (dependencies.createTransport !== undefined) {
    return dependencies.createTransport(config, options.signal);
  }
  return createMcpTransport(
    config,
    {
      resolveSecret: dependencies.resolveSecret,
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
      ...(dependencies.oauthTokenStore === undefined
        ? {}
        : { oauthTokenStore: dependencies.oauthTokenStore }),
      clientCredentialsExtensionEnabled: options.clientCredentialsExtensionEnabled,
      onOAuthProvider: options.onOAuthProvider,
    },
    options.signal,
  );
}

/** Creates a protocol-negotiating MCP client with extension-aware capabilities. */
export function createMcpClient(
  config: ServerConfig,
  clientCredentialsExtensionEnabled: boolean,
  onToolsChanged: (error: Error | null) => void,
): Client {
  const oauthClientCredentials =
    config.transport.kind === "http" &&
    config.transport.auth?.grant === "client_credentials" &&
    clientCredentialsExtensionEnabled;
  const elicitationCapability = config.elicitation.enabled
    ? {
        ...(config.elicitation.modes.includes("form") ? { form: {} } : {}),
        ...(config.elicitation.modes.includes("url") ? { url: {} } : {}),
      }
    : undefined;
  return new Client(
    { name: "rovinos-ai-harness", version: "0.0.0" },
    {
      capabilities: {
        ...(oauthClientCredentials
          ? { extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } }
          : {}),
        ...(elicitationCapability === undefined ? {} : { elicitation: elicitationCapability }),
      },
      versionNegotiation: protocolOptions(config.protocol),
      inputRequired: { autoFulfill: false },
      listChanged: {
        tools: {
          autoRefresh: false,
          onChanged: onToolsChanged,
        },
      },
    },
  );
}
