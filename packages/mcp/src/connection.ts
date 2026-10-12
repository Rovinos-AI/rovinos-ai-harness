// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  SdkError,
  SdkErrorCode,
  specTypeSchemas,
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
  readonly createTransport?: (
    config: ServerConfig,
    signal?: AbortSignal,
  ) => Promise<Transport> | Transport;
  /** Injectable clock returning current epoch milliseconds. */
  readonly now?: () => number;
}

interface CachedToolList {
  readonly tools: readonly McpTool[];
  readonly expiresAt: number;
}

const MAX_TOOLS = 1_000;
const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000] as const;

const ListToolsResultSchema = specTypeSchemas.ListToolsResult;

const schemaValidatorCache = new WeakMap<object, ReturnType<typeof compileJsonSchema>>();

function getOrCreateValidator(inputSchema: unknown): ReturnType<typeof compileJsonSchema> {
  if (typeof inputSchema === "object" && inputSchema !== null) {
    const cached = schemaValidatorCache.get(inputSchema);
    if (cached !== undefined) {
      return cached;
    }
    const validator = compileJsonSchema(inputSchema);
    schemaValidatorCache.set(inputSchema, validator);
    return validator;
  }
  return compileJsonSchema(inputSchema);
}

function isConnectionLossError(error: unknown): boolean {
  if (error instanceof SdkError) {
    if (
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.NotConnected ||
      error.code === SdkErrorCode.SendFailed ||
      error.code === SdkErrorCode.ClientHttpFailedToOpenStream ||
      error.code === SdkErrorCode.ClientHttpFailedToTerminateSession
    ) {
      return true;
    }
  }
  if (error instanceof McpConnectionError && error.code === "mcp_connection_lost") {
    return true;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "CONNECTION_CLOSED" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE"
    ) {
      return true;
    }
  }
  return false;
}

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
  #currentTransport: Transport | undefined;
  #connectPromise: Promise<void> | undefined;
  #activeConnectAbortController: AbortController | undefined;
  #state: McpConnectionState = "unavailable";
  #protocolEra: "legacy" | "modern" | undefined;
  #cachedTools: CachedToolList | undefined;
  #closed = false;
  #connectGeneration = 0;

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

  #now(): number {
    return this.#dependencies.now?.() ?? Date.now();
  }

  /** Connects once; concurrent callers share the same in-flight handshake. */
  async connect(externalSignal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new McpConnectionError("mcp_connect_failed");
    }
    if (this.#state === "ready") {
      return;
    }
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    this.#state = "connecting";
    const generation = ++this.#connectGeneration;
    const abortController = new AbortController();
    this.#activeConnectAbortController = abortController;

    const onCallerAbort = () => {
      abortController.abort();
    };
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        abortController.abort();
      } else {
        externalSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const connectPromise = this.#performConnect(generation, abortController.signal);
    this.#connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", onCallerAbort);
      }
      if (this.#connectPromise === connectPromise) {
        this.#connectPromise = undefined;
        this.#activeConnectAbortController = undefined;
      }
    }
  }

  async #performConnect(generation: number, signal: AbortSignal): Promise<void> {
    let client: Client | undefined;
    let transportToClose: Transport | undefined;
    let combinedSignal: AbortSignal | undefined;
    try {
      const previousClient = this.#client;
      this.#client = undefined;
      this.#currentTransport = undefined;
      if (previousClient !== undefined) {
        await previousClient.close().catch(() => undefined);
      }
      if (this.#closed || this.#connectGeneration !== generation) {
        this.#state = "unavailable";
        return;
      }

      const timeoutSignal = AbortSignal.timeout(this.#config.timeouts.connectMs);
      combinedSignal = AbortSignal.any([timeoutSignal, signal]);

      const transport =
        this.#dependencies.createTransport?.(this.#config, combinedSignal) ??
        createMcpTransport(
          this.#config,
          {
            resolveSecret: this.#dependencies.resolveSecret,
            ...(this.#dependencies.env === undefined ? {} : { env: this.#dependencies.env }),
            ...(this.#dependencies.logger === undefined
              ? {}
              : { logger: this.#dependencies.logger }),
          },
          combinedSignal,
        );
      const resolvedTransport = await transport;
      transportToClose = resolvedTransport;
      if (this.#closed || this.#connectGeneration !== generation) {
        await resolvedTransport.close?.().catch?.(() => undefined);
        this.#state = "unavailable";
        return;
      }

      client = new Client(
        { name: "rovinos-ai-harness", version: "0.0.0" },
        {
          versionNegotiation: protocolOptions(this.#config.protocol),
          listChanged: {
            tools: {
              autoRefresh: false,
              onChanged: (error) => {
                this.#cachedTools = undefined;
                if (error !== null) {
                  this.#dependencies.logger?.log({
                    code: "mcp_tools_refresh_failed",
                    serverId: this.#config.id,
                  });
                  return;
                }
                if (this.#state === "ready") {
                  void this.#fetchTools().catch(() => {
                    this.#dependencies.logger?.log({
                      code: "mcp_tools_refresh_failed",
                      serverId: this.#config.id,
                    });
                  });
                }
              },
            },
          },
        },
      );

      await client.connect(resolvedTransport, {
        signal: combinedSignal,
        timeout: this.#config.timeouts.connectMs,
      });

      if (this.#closed || this.#connectGeneration !== generation) {
        await client.close().catch(() => undefined);
        this.#state = "unavailable";
        return;
      }

      this.#client = client;
      this.#protocolEra = client.getProtocolEra();
      this.#state = "ready";
      this.#watchTransport(resolvedTransport);
    } catch {
      this.#state = "unavailable";
      this.#protocolEra = undefined;
      this.#cachedTools = undefined;
      if (client !== undefined) {
        await client.close().catch(() => undefined);
      } else if (transportToClose !== undefined) {
        await transportToClose.close?.().catch?.(() => undefined);
      }
      throw new McpConnectionError(
        signal.aborted || combinedSignal?.aborted ? "mcp_connect_timeout" : "mcp_connect_failed",
      );
    }
  }

  #watchTransport(transport: Transport): void {
    this.#currentTransport = transport;
    const monitoredTransport = transport;
    const onclose = monitoredTransport.onclose;
    monitoredTransport.onclose = () => {
      onclose?.();
      if (this.#currentTransport === transport) {
        this.#state = "unavailable";
        this.#protocolEra = undefined;
        this.#cachedTools = undefined;
      }
    };
    const onerror = monitoredTransport.onerror;
    monitoredTransport.onerror = (error) => {
      onerror?.(error);
    };
  }

  /** Lists all server tools, honoring caching per ttlMs, pagination, and a 1,000-tool cap. */
  async listTools(): Promise<McpTool[]> {
    await this.#ensureReady();
    const now = this.#now();
    if (this.#cachedTools !== undefined && this.#cachedTools.expiresAt > now) {
      return [...this.#cachedTools.tools];
    }
    return this.#fetchTools();
  }

  async #fetchTools(): Promise<McpTool[]> {
    const client = this.#client;
    if (client === undefined || this.#state !== "ready") {
      throw new McpConnectionError("mcp_list_tools_failed");
    }

    const tools: McpTool[] = [];
    let cursor: string | undefined = undefined;
    const seenCursors = new Set<string>();
    let ttlMs: number | undefined = undefined;

    try {
      while (true) {
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) {
            throw new McpConnectionError("mcp_list_tools_failed");
          }
          seenCursors.add(cursor);
        }

        const page: ListToolsResult = await client.request(
          {
            method: "tools/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          },
          ListToolsResultSchema,
          { timeout: this.#config.timeouts.callMs },
        );

        const pageTools = page.tools;
        const pageTtlMs = (page as { ttlMs?: unknown }).ttlMs;
        if (typeof pageTtlMs === "number" && ttlMs === undefined) {
          ttlMs = pageTtlMs;
        }

        for (const tool of pageTools) {
          tools.push(tool);
          if (tools.length > MAX_TOOLS) {
            throw new McpConnectionError("mcp_too_many_tools");
          }
        }

        if (page.nextCursor === undefined || page.nextCursor === "" || pageTools.length === 0) {
          break;
        }
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (error instanceof McpConnectionError) {
        throw error;
      }
      throw new McpConnectionError("mcp_list_tools_failed");
    }

    const effectiveTtl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : 0;
    this.#cachedTools = {
      tools,
      expiresAt: this.#now() + effectiveTtl,
    };

    return [...tools];
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
      validate = getOrCreateValidator(inputSchema);
      validate(params.arguments ?? {});
    } catch {
      throw new McpConnectionError("mcp_tool_arguments_invalid");
    }

    await this.#ensureReady(options?.signal);
    try {
      return await this.#invoke(params, options);
    } catch (error) {
      const isLoss = isConnectionLossError(error) || this.#state === "unavailable";
      if (!isLoss) {
        throw new McpConnectionError("mcp_tool_call_failed");
      }
      this.#state = "unavailable";
      this.#protocolEra = undefined;
      this.#cachedTools = undefined;
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
    if (this.#closed) {
      throw new McpConnectionError("mcp_connection_lost");
    }
    if (this.#state === "ready") {
      return;
    }
    await this.#reconnect(signal);
  }

  async #reconnect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new McpConnectionError("mcp_connection_lost");
    }
    let lastError: unknown;
    for (const delay of RECONNECT_BACKOFF_MS) {
      if (this.#closed) {
        throw new McpConnectionError("mcp_connection_lost");
      }
      if (isAborted(signal)) {
        throw new McpConnectionError("mcp_connect_timeout");
      }
      await (this.#dependencies.sleep ?? defaultSleep)(delay);
      if (this.#closed) {
        throw new McpConnectionError("mcp_connection_lost");
      }
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
    this.#closed = true;
    this.#connectGeneration++;
    this.#activeConnectAbortController?.abort();
    const connectPromise = this.#connectPromise;
    const client = this.#client;
    this.#client = undefined;
    this.#currentTransport = undefined;
    this.#protocolEra = undefined;
    this.#state = "unavailable";
    this.#cachedTools = undefined;

    if (connectPromise !== undefined) {
      await connectPromise.catch(() => undefined);
    }
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}
