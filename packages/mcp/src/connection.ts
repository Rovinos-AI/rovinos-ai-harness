// SPDX-License-Identifier: Apache-2.0
import {
  type Client,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import { McpConnectionError, McpProtocolError, isConnectionLossError } from "./errors.js";
import type { McpOAuthProvider } from "./oauth/provider.js";
import { LegacyConnectionElicitation } from "./legacy-connection.js";
import type { ElicitationRetry } from "./elicitation/mrtr.js";
import { getServerMetadata, type McpServerMetadata } from "./server-metadata.js";
import type { McpTool } from "./tool-list.js";
import type { GetPromptResult, McpPrompt } from "./prompts.js";
import { PromptConnection } from "./prompt-connection.js";
import { DiscoveryTask } from "./discovery-budget.js";
import type {
  ConnectionToolCall,
  McpConnectionDependencies,
  McpConnectionState,
} from "./connection-types.js";
import {
  type CachedToolList,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  ClientCredentialsExtensionSupport,
  createConfiguredTransport,
  createMcpClient,
  discoverConnectionTools,
  discoveryConnectionError,
  defaultSleep,
  getOrCreateValidator,
  invokeConnectionTool,
  reconnectWithBackoff,
  runWithSafeAuthLogging,
  connectionCallError,
  handleConnectionToolsChanged,
  handleConnectionConnectFailure,
  watchConnectionTransport,
} from "./connection-helpers.js";

export type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
export { McpConnectionError, type McpConnectionErrorCode } from "./errors.js";
export { excludeHeaderDeclaringTools, type McpTool } from "./tool-list.js";

/**
 * Manages one MCP SDK client, its transport, tool discovery, and reconnection.
 */
export class McpConnection {
  readonly #config: ServerConfig;
  readonly #dependencies: McpConnectionDependencies;
  readonly #now = (): number => this.#dependencies.now?.() ?? Date.now();
  #client: Client | undefined;
  #currentTransport: Transport | undefined;
  #connectPromise: Promise<void> | undefined;
  #activeConnectAbortController: AbortController | undefined;
  #state: McpConnectionState = "unavailable";
  #protocolEra: "legacy" | "modern" | undefined;
  #cachedTools: CachedToolList | undefined;
  readonly #discovery = new DiscoveryTask<McpTool[]>();
  #toolsGeneration = 0;
  readonly #clientCredentialsExtension = new ClientCredentialsExtensionSupport();
  readonly #legacyElicitation = new LegacyConnectionElicitation();
  readonly #prompts: PromptConnection;
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
    this.#prompts = new PromptConnection({
      config,
      client: () => this.#client,
      protocolEra: () => this.#protocolEra,
      now: this.#now,
      ensureReady: (signal) => this.#ensureReady(signal),
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
    const connectTimeout = AbortSignal.timeout(this.#config.timeouts.connectMs);
    const combinedSignal = AbortSignal.any([connectTimeout, signal]);
    const isStale = () => this.#closed || this.#connectGeneration !== generation;
    let transport: Transport | undefined, client: Client | undefined;
    try {
      await this.#closeCurrentClient();
      if (isStale()) {
        this.#state = "unavailable";
        return;
      }
      await this.#probeClientCredentialsExtension(combinedSignal);
      const activeTransport = await createConfiguredTransport(this.#config, this.#dependencies, {
        clientCredentialsExtensionEnabled: this.#clientCredentialsExtension.supported,
        onOAuthProvider: (provider) => {
          this.#oauthProvider = provider;
        },
        signal: combinedSignal,
      });
      transport = activeTransport;
      if (isStale()) {
        this.#state = "unavailable";
        await activeTransport.close().catch(() => undefined);
        return;
      }
      const activeClient = createMcpClient(
        this.#config,
        this.#clientCredentialsExtension.supported,
        (error) => {
          handleConnectionToolsChanged({
            error,
            serverId: this.#config.id,
            logger: this.#dependencies.logger,
            onChange: () => {
              this.#toolsGeneration++;
              this.#cachedTools = undefined;
            },
            isReady: () => this.#state === "ready",
            refresh: () => this.#fetchTools(),
          });
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
      if (isStale()) {
        this.#state = "unavailable";
        await activeClient.close().catch(() => undefined);
        return;
      }
      this.#client = activeClient;
      this.#protocolEra = activeClient.getProtocolEra();
      this.#state = "ready";
      this.#currentTransport = activeTransport;
      watchConnectionTransport(activeTransport, () => {
        if (this.#currentTransport === activeTransport) {
          this.#state = "unavailable";
          this.#protocolEra = undefined;
          this.#cachedTools = undefined;
        }
      });
    } catch (error) {
      await this.#handleConnectFailure(error, combinedSignal, client, transport);
    }
  }

  #handleConnectFailure(
    error: unknown,
    signal: AbortSignal,
    client: Client | undefined,
    transport: Transport | undefined,
  ): Promise<never> {
    return handleConnectionConnectFailure({
      error,
      signal,
      client,
      transport,
      markUnavailable: this.#markUnavailable.bind(this),
    });
  }

  async #probeClientCredentialsExtension(signal: AbortSignal): Promise<void> {
    await this.#clientCredentialsExtension.probe(
      this.#config,
      signal,
      this.#dependencies.createTransport !== undefined,
    );
  }

  async #closeCurrentClient(): Promise<void> {
    this.#discovery.cancel();
    const previousClient = this.#client;
    this.#client = undefined;
    this.#currentTransport = undefined;
    this.#legacyElicitation.clear();
    await previousClient?.close().catch(() => undefined);
  }

  #markUnavailable(): void {
    this.#state = "unavailable";
    this.#protocolEra = undefined;
    this.#cachedTools = undefined;
  }

  /**
   * Lists tools under finite discovery budgets, caching only complete results.
   * Concurrent refreshes share work; cancellation by any caller cancels that shared refresh.
   */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (signal?.aborted === true) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    await this.#ensureReady(signal);
    const now = this.#now();
    if (this.#cachedTools !== undefined && this.#cachedTools.expiresAt > now) {
      return [...this.#cachedTools.tools];
    }
    return this.#fetchTools(signal);
  }

  /** Lists prompts under finite discovery budgets without declaring client prompt capabilities. */
  async listPrompts(signal?: AbortSignal): Promise<McpPrompt[]> {
    return this.#prompts.list(signal);
  }

  /** Retrieves one prompt on this server connection using its current advertised arguments. */
  async getPrompt(
    name: string,
    arguments_: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    return this.#prompts.get(name, arguments_, signal);
  }

  async #fetchTools(signal?: AbortSignal): Promise<McpTool[]> {
    return [
      ...(await this.#discovery.run((activeSignal) => this.#discoverTools(activeSignal), signal)),
    ];
  }

  async #discoverTools(signal: AbortSignal): Promise<McpTool[]> {
    const client = this.#client;
    const generation = this.#toolsGeneration;
    if (client === undefined || this.#state !== "ready") {
      throw new McpConnectionError("mcp_list_tools_failed");
    }
    let listed: Awaited<ReturnType<typeof discoverConnectionTools>>;
    try {
      listed = await discoverConnectionTools(client, this.#config, this.#dependencies, {
        era: this.#protocolEra,
        signal,
      });
    } catch (error) {
      throw discoveryConnectionError(error, () => {
        this.#markUnavailable();
      });
    }
    if (signal.aborted || this.#client !== client) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    if (generation !== this.#toolsGeneration) {
      throw new McpConnectionError("mcp_list_tools_failed");
    }
    const ttlMs = listed.ttlMs !== undefined && listed.ttlMs > 0 ? listed.ttlMs : 0;
    this.#cachedTools = { tools: listed.tools, expiresAt: this.#now() + ttlMs };
    return [...listed.tools];
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
      this.#cachedTools = undefined;
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

  async #ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new McpConnectionError("mcp_connection_lost");
    }
    if (this.#state === "ready") {
      return;
    }
    await this.#reconnect(signal);
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
    this.#discovery.cancel();
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
