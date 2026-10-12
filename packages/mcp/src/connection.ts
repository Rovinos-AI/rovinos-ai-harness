// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  specTypeSchemas,
  type CallToolRequestOptions,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import { compileJsonSchema, type SecretRef, type ServerConfig } from "@harness/schemas";
import { McpConnectionError, isConnectionLossError } from "./errors.js";
import { listAllTools, type McpTool } from "./tool-list.js";
import { createMcpTransport, type McpLogger } from "./transports.js";

export { McpConnectionError, type McpConnectionErrorCode } from "./errors.js";
export { excludeHeaderDeclaringTools, type McpTool } from "./tool-list.js";

/** Observable lifecycle state for one MCP server connection. */
export type McpConnectionState = "connecting" | "ready" | "unavailable";

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

const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000] as const;

const ListToolsResultSchema = specTypeSchemas.ListToolsResult;

const schemaValidatorCache = new WeakMap<Record<string, unknown>, (value: unknown) => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOrCreateValidator(inputSchema: unknown): (value: unknown) => void {
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

  /** Whether a connect attempt was superseded by `close()` or a newer attempt. */
  #isStale(generation: number): boolean {
    return this.#closed || this.#connectGeneration !== generation;
  }

  async #performConnect(generation: number, signal: AbortSignal): Promise<void> {
    const combinedSignal = AbortSignal.any([
      AbortSignal.timeout(this.#config.timeouts.connectMs),
      signal,
    ]);
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      await this.#closeCurrentClient();
      if (this.#isStale(generation)) {
        this.#state = "unavailable";
        return;
      }
      transport = await this.#createTransport(combinedSignal);
      if (this.#isStale(generation)) {
        this.#state = "unavailable";
        await transport.close().catch(() => undefined);
        return;
      }
      client = this.#createClient();
      await client.connect(transport, {
        signal: combinedSignal,
        timeout: this.#config.timeouts.connectMs,
      });
      if (this.#isStale(generation)) {
        this.#state = "unavailable";
        await client.close().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#protocolEra = client.getProtocolEra();
      this.#state = "ready";
      this.#watchTransport(transport);
    } catch {
      this.#markUnavailable();
      await (client ?? transport)?.close().catch(() => undefined);
      throw new McpConnectionError(
        combinedSignal.aborted ? "mcp_connect_timeout" : "mcp_connect_failed",
      );
    }
  }

  async #closeCurrentClient(): Promise<void> {
    const previousClient = this.#client;
    this.#client = undefined;
    this.#currentTransport = undefined;
    await previousClient?.close().catch(() => undefined);
  }

  #markUnavailable(): void {
    this.#state = "unavailable";
    this.#protocolEra = undefined;
    this.#cachedTools = undefined;
  }

  async #createTransport(signal: AbortSignal): Promise<Transport> {
    const { createTransport, resolveSecret, env, logger } = this.#dependencies;
    if (createTransport !== undefined) {
      return createTransport(this.#config, signal);
    }
    return createMcpTransport(
      this.#config,
      {
        resolveSecret,
        ...(env === undefined ? {} : { env }),
        ...(logger === undefined ? {} : { logger }),
      },
      signal,
    );
  }

  #createClient(): Client {
    return new Client(
      { name: "rovinos-ai-harness", version: "0.0.0" },
      {
        versionNegotiation: protocolOptions(this.#config.protocol),
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error) => {
              this.#onToolsChanged(error);
            },
          },
        },
      },
    );
  }

  #onToolsChanged(error: Error | null): void {
    this.#cachedTools = undefined;
    const logRefreshFailure = () => {
      this.#dependencies.logger?.log({
        code: "mcp_tools_refresh_failed",
        serverId: this.#config.id,
      });
    };
    if (error !== null) {
      logRefreshFailure();
      return;
    }
    if (this.#state === "ready") {
      void this.#fetchTools().catch(logRefreshFailure);
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
    let listed: Awaited<ReturnType<typeof listAllTools>>;
    try {
      listed = await listAllTools({
        requestPage: (cursor) =>
          client.request(
            { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
            ListToolsResultSchema,
            { timeout: this.#config.timeouts.callMs },
          ),
        era: this.#protocolEra,
        transport: this.#config.transport.kind,
        onExcluded: (count) => {
          this.#dependencies.logger?.log({
            code: "mcp_tools_excluded",
            serverId: this.#config.id,
            count,
          });
        },
      });
    } catch (error) {
      throw error instanceof McpConnectionError
        ? error
        : new McpConnectionError("mcp_list_tools_failed");
    }
    const ttlMs = listed.ttlMs !== undefined && listed.ttlMs > 0 ? listed.ttlMs : 0;
    this.#cachedTools = { tools: listed.tools, expiresAt: this.#now() + ttlMs };
    return [...listed.tools];
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

  /** Throws when the connection was closed or the caller gave up, before and after each wait. */
  #assertMayReconnect(signal?: AbortSignal): void {
    if (this.#closed) {
      throw new McpConnectionError("mcp_connection_lost");
    }
    if (isAborted(signal)) {
      throw new McpConnectionError("mcp_connect_timeout");
    }
  }

  async #reconnect(signal?: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (const delay of RECONNECT_BACKOFF_MS) {
      this.#assertMayReconnect(signal);
      await (this.#dependencies.sleep ?? defaultSleep)(delay);
      this.#assertMayReconnect(signal);
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
