// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  type CallToolRequestOptions,
  type CallToolResult,
  type ListToolsResult,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  HarnessError,
  compileJsonSchema,
  type SecretRef,
  type ServerConfig,
} from "@harness/schemas";
import { createMcpTransport, type McpLogger } from "./transports.js";

/** Stable failures raised by an MCP connection without exposing server text. */
export type McpConnectionErrorCode =
  | "mcp_connect_failed"
  | "mcp_connect_timeout"
  | "mcp_connection_lost"
  | "mcp_list_tools_failed"
  | "mcp_too_many_tools"
  | "mcp_tool_arguments_invalid"
  | "mcp_tool_call_failed";

/** Safe connection error with a closed code and no remote-provided message. */
export class McpConnectionError extends HarnessError {
  override readonly code: McpConnectionErrorCode;

  /** Creates a safe MCP error. */
  constructor(code: McpConnectionErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Observable lifecycle state for one MCP server connection. */
export type McpConnectionState = "connecting" | "ready" | "unavailable";

/** MCP tools discovered from a server. */
export type McpTool = ListToolsResult["tools"][number];

/** Dependencies injected at the connection boundary. */
export interface McpConnectionDependencies {
  /** Resolves validated server secret references when a transport is created. */
  readonly resolveSecret: (ref: SecretRef, signal?: AbortSignal) => Promise<string>;
  /** Optional logger that accepts only safe codes and stderr byte counts. */
  readonly logger?: McpLogger;
  /** Injectable reconnect delay used by tests and host runtimes. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Process environment source for the stdio PATH allowlist. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional transport factory for in-memory tests and embedded transports. */
  readonly createTransport?: (config: ServerConfig, signal: AbortSignal) => Promise<Transport>;
}

const MAX_TOOLS = 1_000;
const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000] as const;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function protocolOptions(protocol: ServerConfig["protocol"]) {
  if (protocol === "auto") {
    return { mode: "auto" as const };
  }
  if (protocol === "2026-07-28") {
    return { mode: { pin: protocol } };
  }
  return { mode: "legacy" as const };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Manages one MCP SDK client, its transport, tool discovery, and reconnection.
 */
export class McpConnection {
  readonly #config: ServerConfig;
  readonly #dependencies: McpConnectionDependencies;
  #client: Client | undefined;
  #connectPromise: Promise<void> | undefined;
  #state: McpConnectionState = "unavailable";
  #protocolEra: "legacy" | "modern" | undefined;

  /**
   * Creates a connection for one validated server configuration.
   *
   * @param config - Validated server configuration.
   * @param dependencies - Secret resolver, logger, and deterministic backoff hooks.
   */
  constructor(config: ServerConfig, dependencies: McpConnectionDependencies) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  /** Current lifecycle state. */
  get state(): McpConnectionState {
    return this.#state;
  }

  /** Negotiated protocol era, or `undefined` until a connection is ready. */
  get protocolEra(): "legacy" | "modern" | undefined {
    return this.#protocolEra;
  }

  /** Connects once; concurrent callers share the same in-flight handshake. */
  async connect(externalSignal?: AbortSignal): Promise<void> {
    if (this.#state === "ready") {
      return;
    }
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    this.#state = "connecting";
    const connectPromise = this.#connect(externalSignal);
    this.#connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async #connect(externalSignal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.#config.timeouts.connectMs);
    const signal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, externalSignal]);
    let client: Client | undefined;
    try {
      const previousClient = this.#client;
      this.#client = undefined;
      if (previousClient !== undefined) {
        await previousClient.close().catch(() => undefined);
      }
      const transport =
        this.#dependencies.createTransport?.(this.#config, signal) ??
        createMcpTransport(this.#config, {
          resolveSecret: this.#dependencies.resolveSecret,
          ...(this.#dependencies.env === undefined ? {} : { env: this.#dependencies.env }),
          ...(this.#dependencies.logger === undefined ? {} : { logger: this.#dependencies.logger }),
        }, signal);
      const resolvedTransport = await transport;
      client = new Client(
        { name: "rovinos-ai-harness", version: "0.0.0" },
        {
          versionNegotiation: protocolOptions(this.#config.protocol),
          listMaxPages: MAX_TOOLS,
          listChanged: {
            tools: {
              onChanged: (error) => {
                if (error !== null) {
                  this.#dependencies.logger?.log({
                    code: "mcp_tools_refresh_failed",
                    serverId: this.#config.id,
                  });
                }
              },
            },
          },
        },
      );
      await client.connect(resolvedTransport, { signal, timeout: this.#config.timeouts.connectMs });
      this.#client = client;
      this.#protocolEra = client.getProtocolEra();
      this.#state = "ready";
      this.#watchTransport(resolvedTransport);
    } catch {
      this.#state = "unavailable";
      this.#protocolEra = undefined;
      if (client !== undefined) {
        await client.close().catch(() => undefined);
      }
      throw new McpConnectionError(signal.aborted ? "mcp_connect_timeout" : "mcp_connect_failed");
    }
  }

  #watchTransport(transport: Transport): void {
    const onclose = transport.onclose;
    transport.onclose = () => {
      onclose?.();
      this.#state = "unavailable";
      this.#protocolEra = undefined;
    };
    const onerror = transport.onerror;
    transport.onerror = (error) => {
      onerror?.(error);
      this.#state = "unavailable";
      this.#protocolEra = undefined;
    };
  }

  /** Lists all server tools, honoring SDK pagination/cache behavior and a 1,000-tool cap. */
  async listTools(): Promise<McpTool[]> {
    await this.#ensureReady();
    const client = this.#client;
    if (client === undefined) {
      throw new McpConnectionError("mcp_list_tools_failed");
    }
    try {
      const { tools } = await client.listTools(undefined, {
        timeout: this.#config.timeouts.callMs,
      });
      if (tools.length > MAX_TOOLS) {
        throw new McpConnectionError("mcp_too_many_tools");
      }
      return tools;
    } catch (error) {
      if (error instanceof McpConnectionError) {
        throw error;
      }
      throw new McpConnectionError("mcp_list_tools_failed");
    }
  }

  /**
   * Validates tool arguments before network I/O and calls the remote tool.
   *
   * @param params - Native tool name and arguments.
   * @param inputSchema - Untrusted JSON Schema supplied by the tool registry.
   * @param options - SDK request options such as the cancellation signal.
   * @returns The remote tool result.
   */
  async callTool(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    inputSchema: unknown,
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult> {
    let validate: ReturnType<typeof compileJsonSchema>;
    try {
      validate = compileJsonSchema(inputSchema);
      validate(params.arguments ?? {});
    } catch {
      throw new McpConnectionError("mcp_tool_arguments_invalid");
    }

    await this.#ensureReady(options?.signal);
    try {
      return await this.#invoke(params, options);
    } catch {
      if (this.#state !== "unavailable") {
        throw new McpConnectionError("mcp_tool_call_failed");
      }
      if (!this.#isIdempotent(params.name)) {
        throw new McpConnectionError("mcp_connection_lost");
      }
      await this.#reconnect(options?.signal);
      try {
        return await this.#invoke(params, options);
      } catch {
        throw new McpConnectionError("mcp_connection_lost");
      }
    }
  }

  async #invoke(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    options?: CallToolRequestOptions,
  ): Promise<CallToolResult> {
    const client = this.#client;
    if (client === undefined || this.#state !== "ready") {
      throw new McpConnectionError("mcp_connection_lost");
    }
    return client.callTool(params, {
      timeout: this.#config.timeouts.callMs,
      ...options,
    });
  }

  async #ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.#state === "ready") {
      return;
    }
    await this.#reconnect(signal);
  }

  async #reconnect(signal?: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (const delay of RECONNECT_BACKOFF_MS) {
      if (isAborted(signal)) {
        throw new McpConnectionError("mcp_connect_timeout");
      }
      await (this.#dependencies.sleep ?? defaultSleep)(delay);
      if (isAborted(signal)) {
        throw new McpConnectionError("mcp_connect_timeout");
      }
      try {
        await this.connect(signal);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof McpConnectionError) {
      throw lastError;
    }
    throw new McpConnectionError("mcp_connect_failed");
  }

  #isIdempotent(name: string): boolean {
    return this.#config.idempotentTools?.includes(name) === true;
  }

  /** Closes the SDK client and marks the connection unavailable. */
  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#protocolEra = undefined;
    this.#state = "unavailable";
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}
