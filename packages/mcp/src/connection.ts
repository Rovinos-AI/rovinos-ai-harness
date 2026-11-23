// SPDX-License-Identifier: Apache-2.0
import {
  type Client,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import {
  McpConnectionError,
  McpProtocolError,
  isConnectionLossError,
  type McpConnectionErrorCode,
} from "./errors.js";
import { McpAuthRequiredError } from "./oauth/provider.js";
import type { McpOAuthProvider } from "./oauth/provider.js";
import {
  LegacyConnectionElicitation,
  type LegacyElicitationCallbacks,
} from "./legacy-connection.js";
import type { ElicitationRetry } from "./elicitation/mrtr.js";
import { getServerMetadata, type McpServerMetadata } from "./server-metadata.js";
import type { McpTool } from "./tool-list.js";
import type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
import { ResourceConnection } from "./resource-connection.js";
import {
  type McpResource,
  type McpResourceRead,
  type ResourceTextTokenizer,
} from "./resource-access.js";
import {
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  ClientCredentialsExtensionSupport,
  createConfiguredTransport,
  createMcpClient,
  defaultSleep,
  getOrCreateValidator,
  isConnectionStale,
  invokeConnectionTool,
  observeTransportClose,
  reconnectWithBackoff,
  runWithSafeAuthLogging,
  connectionCallError,
} from "./connection-helpers.js";
import { ConnectionToolDiscovery } from "./tool-discovery.js";

export type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
export { McpConnectionError, type McpConnectionErrorCode } from "./errors.js";
export { excludeHeaderDeclaringTools, type McpTool } from "./tool-list.js";

interface ConnectionToolCall {
  readonly params: CallToolRequest["params"];
  readonly inputSchema: unknown;
  readonly options?: CallToolRequestOptions;
  readonly toolDefinition?: McpTool;
  readonly inputRetry?: ElicitationRetry;
  readonly legacyElicitation?: LegacyElicitationCallbacks;
}

/**
 * Manages one MCP SDK client, its transport, tool discovery, and reconnection.
 */
export class McpConnection {
  readonly #config: ServerConfig;
  readonly #dependencies: McpConnectionDependencies;
  readonly #resourceConnection: ResourceConnection;
  readonly #toolDiscovery: ConnectionToolDiscovery;
  #client: Client | undefined;
  #currentTransport: Transport | undefined;
  #connectPromise: Promise<void> | undefined;
  #activeConnectAbortController: AbortController | undefined;
  #state: McpConnectionState = "unavailable";
  #protocolEra: "legacy" | "modern" | undefined;
  readonly #clientCredentialsExtension = new ClientCredentialsExtensionSupport();
  readonly #legacyElicitation = new LegacyConnectionElicitation();
  #oauthProvider: McpOAuthProvider | undefined;
  #closed = false;
  #connectGeneration = 0;

  /**
   * Creates a connection for one validated server configuration.
   *
   * @param config - Validated server configuration.
   * @param dependencies - Secret resolver, logger, and deterministic backoff hooks.
   * @throws McpConnectionError when outbound MCP Apps are enabled, which this client does not support.
   */
  constructor(config: ServerConfig, dependencies: McpConnectionDependencies) {
    if (config.apps) {
      throw new McpConnectionError("mcp_apps_unsupported");
    }
    this.#config = config;
    this.#dependencies = dependencies;
    this.#resourceConnection = new ResourceConnection(config);
    this.#toolDiscovery = new ConnectionToolDiscovery(config, dependencies, {
      ensureReady: (signal) => this.#ensureReady(signal),
      getClient: () => this.#client,
      getProtocolEra: () => this.#protocolEra,
      getState: () => this.#state,
      markUnavailable: this.#markUnavailable.bind(this),
    });
  }

  /** Current lifecycle state. */
  get state(): McpConnectionState {
    return this.#state;
  }

  /** Negotiated protocol era, or `undefined` until a connection is ready. */
  get protocolEra(): "legacy" | "modern" | undefined {
    return this.#protocolEra;
  }

  /** Safe negotiated server metadata for diagnostics. */
  get serverMetadata(): McpServerMetadata {
    return getServerMetadata(this.#client);
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
    const combinedSignal = AbortSignal.any([
      AbortSignal.timeout(this.#config.timeouts.connectMs),
      signal,
    ]);
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      await this.#closeCurrentClient();
      if (isConnectionStale(this.#closed, this.#connectGeneration, generation)) {
        this.#state = "unavailable";
        return;
      }
      await this.#clientCredentialsExtension.probe(
        this.#config,
        combinedSignal,
        this.#dependencies.createTransport !== undefined,
      );
      const activeTransport = await createConfiguredTransport(this.#config, this.#dependencies, {
        clientCredentialsExtensionEnabled: this.#clientCredentialsExtension.supported,
        onOAuthProvider: (provider) => {
          this.#oauthProvider = provider;
        },
        signal: combinedSignal,
      });
      transport = activeTransport;
      if (isConnectionStale(this.#closed, this.#connectGeneration, generation)) {
        this.#state = "unavailable";
        await activeTransport.close().catch(() => undefined);
        return;
      }
      const activeClient = createMcpClient(
        this.#config,
        this.#clientCredentialsExtension.supported,
        (error) => {
          this.#onToolsChanged(error);
        },
      );
      client = activeClient;
      this.#legacyElicitation.register(activeClient, this.#config.elicitation.enabled);
      await runWithSafeAuthLogging(
        this.#config.transport.kind === "http" && this.#config.transport.auth !== undefined,
        () =>
          activeClient.connect(activeTransport, {
            signal: combinedSignal,
            timeout: this.#config.timeouts.connectMs,
          }),
      );
      this.#clientCredentialsExtension.observe(
        activeClient.getServerCapabilities()?.extensions?.[OAUTH_CLIENT_CREDENTIALS_EXTENSION] !==
          undefined,
      );
      this.#oauthProvider?.setClientCredentialsExtensionEnabled(
        this.#clientCredentialsExtension.supported,
      );
      if (isConnectionStale(this.#closed, this.#connectGeneration, generation)) {
        this.#state = "unavailable";
        await activeClient.close().catch(() => undefined);
        return;
      }
      this.#client = activeClient;
      this.#protocolEra = activeClient.getProtocolEra();
      this.#resourceConnection.attach(activeClient, this.#protocolEra);
      this.#state = "ready";
      this.#watchTransport(activeTransport);
    } catch (error) {
      this.#markUnavailable();
      await (client ?? transport)?.close().catch(() => undefined);
      let code: McpConnectionErrorCode = "mcp_connect_failed";
      if (error instanceof McpAuthRequiredError) {
        code = "mcp_auth_required";
      } else if (combinedSignal.aborted) {
        code = "mcp_connect_timeout";
      }
      throw new McpConnectionError(code);
    }
  }

  async #closeCurrentClient(): Promise<void> {
    this.#toolDiscovery.cancel();
    await this.#resourceConnection.close();
    const previousClient = this.#client;
    this.#client = undefined;
    this.#currentTransport = undefined;
    this.#legacyElicitation.clear();
    await previousClient?.close().catch(() => undefined);
  }

  #markUnavailable(): void {
    this.#state = "unavailable";
    this.#protocolEra = undefined;
    this.#toolDiscovery.invalidate();
    this.#resourceConnection.invalidate();
  }

  #onToolsChanged(error: Error | null): void {
    this.#toolDiscovery.invalidate();
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
      void this.#toolDiscovery.list().catch(logRefreshFailure);
    }
  }

  #watchTransport(transport: Transport): void {
    this.#currentTransport = transport;
    observeTransportClose(transport, () => {
      if (this.#currentTransport === transport) {
        this.#markUnavailable();
      }
    });
  }

  /**
   * Lists tools under finite discovery budgets, caching only complete results.
   * Concurrent refreshes share work; cancellation by any caller cancels that shared refresh.
   */
  listTools(signal?: AbortSignal): Promise<McpTool[]> {
    return this.#toolDiscovery.list(signal);
  }

  /**
   * Lists only resources covered by this server's grants and tokenizes returned strings.
   * @param options - Model-input tokenizer and optional cancellation signal.
   * @returns Granted resource metadata with opaque grant provenance.
   */
  listResources(options: {
    readonly signal?: AbortSignal;
    readonly tokenizeText: ResourceTextTokenizer;
  }): Promise<McpResource[]> {
    return this.#resourceConnection.list(options, (signal) => this.#ensureReady(signal));
  }

  /**
   * Reads a trusted code-selected resource batch without exposing partial results.
   * @param uris - Resource URIs on this server; model/user input must not select these directly.
   * @param options - Model-input tokenizer and optional cancellation signal.
   * @returns Tokenized text contents with server and grant provenance.
   */
  async readResources(
    uris: readonly string[],
    options: {
      readonly signal?: AbortSignal;
      readonly tokenizeText: ResourceTextTokenizer;
    },
  ): Promise<McpResourceRead[]> {
    try {
      return await this.#resourceConnection.read(uris, options, (signal) =>
        this.#ensureReady(signal),
      );
    } catch (error) {
      if (
        this.#protocolEra === "legacy" &&
        error instanceof McpConnectionError &&
        (error.code === "mcp_discovery_cancelled" || error.code === "mcp_resource_timeout")
      ) {
        this.#markUnavailable();
        await this.#closeCurrentClient();
      }
      throw error;
    }
  }

  /**
   * Subscribes only when this server advertises resource subscriptions.
   * @param uri - Trusted code-selected resource URI on this server.
   * @param signal - Optional cancellation signal.
   */
  subscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    return this.#resourceConnection.subscribe(uri, signal, (activeSignal) =>
      this.#ensureReady(activeSignal),
    );
  }

  /** Stops a previously enabled resource subscription. */
  unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    return this.#resourceConnection.unsubscribe(uri, signal);
  }

  /**
   * Validates tool arguments before network I/O and calls the remote tool.
   * @param request - Native tool request and its schema and retry options.
   * @returns The remote tool result.
   */
  async callTool(request: ConnectionToolCall): Promise<CallToolResult> {
    if (this.#config.elicitation.enabled && this.#protocolEra !== "modern") {
      return this.#legacyElicitation.serialize(() => this.#callTool(request));
    }
    return this.#callTool(request);
  }

  async #callTool(request: ConnectionToolCall): Promise<CallToolResult> {
    const { params, inputSchema, options, toolDefinition, inputRetry } = request;
    try {
      const validate = getOrCreateValidator(inputSchema);
      validate(params.arguments ?? {});
    } catch {
      throw new McpConnectionError("mcp_tool_arguments_invalid");
    }

    await this.#ensureReady(options?.signal);
    this.#legacyElicitation.bind(request.legacyElicitation);
    try {
      return await this.#invoke(params, options, toolDefinition, inputRetry);
    } catch (error) {
      const connectionError = connectionCallError(error);
      if (connectionError !== undefined) {
        this.#markUnavailable();
        throw connectionError;
      }
      if (error instanceof McpProtocolError) {
        this.#legacyElicitation.trackError(error, request.legacyElicitation);
        throw error;
      }
      const isLoss = isConnectionLossError(error) || this.#state === "unavailable";
      if (!isLoss) {
        throw new McpConnectionError("mcp_tool_call_failed");
      }
      this.#state = "unavailable";
      this.#protocolEra = undefined;
      this.#toolDiscovery.invalidate();
      if (this.#config.idempotentTools?.includes(params.name) !== true) {
        throw new McpConnectionError("mcp_connection_lost");
      }
      await this.#reconnect(options?.signal);
      try {
        return await this.#invoke(params, options, toolDefinition, inputRetry);
      } catch (retryError) {
        if (retryError instanceof McpProtocolError) {
          this.#legacyElicitation.trackError(retryError, request.legacyElicitation);
          throw retryError;
        }
        throw new McpConnectionError("mcp_connection_lost");
      }
    } finally {
      this.#legacyElicitation.bind(undefined);
    }
  }

  #invoke(
    params: CallToolRequest["params"],
    options?: CallToolRequestOptions,
    toolDefinition?: McpTool,
    inputRetry?: ElicitationRetry,
  ): Promise<CallToolResult> {
    return invokeConnectionTool({
      config: this.#config,
      client: this.#client,
      state: this.#state,
      params,
      ...(options === undefined ? {} : { requestOptions: options }),
      ...(toolDefinition === undefined ? {} : { toolDefinition }),
      ...(inputRetry === undefined ? {} : { inputRetry }),
    });
  }

  #ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new McpConnectionError("mcp_connection_lost"));
    }
    if (this.#state === "ready") {
      return Promise.resolve();
    }
    return this.#reconnect(signal);
  }

  #reconnect(signal?: AbortSignal): Promise<void> {
    return reconnectWithBackoff({
      isClosed: () => this.#closed,
      signal,
      sleep: this.#dependencies.sleep ?? defaultSleep,
      connect: (connectSignal) => this.connect(connectSignal),
    });
  }

  /** Closes the SDK client and marks the connection unavailable. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#connectGeneration++;
    this.#activeConnectAbortController?.abort();
    this.#toolDiscovery.cancel();
    const connectPromise = this.#connectPromise;
    const client = this.#client;
    this.#client = undefined;
    this.#currentTransport = undefined;
    this.#protocolEra = undefined;
    this.#state = "unavailable";
    this.#toolDiscovery.invalidate();

    if (connectPromise !== undefined) {
      await connectPromise.catch(() => undefined);
    }
    await this.#resourceConnection.close();
    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}
