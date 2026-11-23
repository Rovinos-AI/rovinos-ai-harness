// SPDX-License-Identifier: Apache-2.0
import {
  specTypeSchemas,
  SdkError,
  SdkErrorCode,
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
  McpPromptError,
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
import {
  GetPromptResultSchema,
  ListPromptsResultSchema,
  listAllPrompts,
  type GetPromptResult,
  type McpPrompt,
} from "./prompts.js";
import { DiscoveryTask } from "./discovery-budget.js";
import type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
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
} from "./connection-helpers.js";

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
      await this.#probeClientCredentialsExtension(combinedSignal);
      const activeTransport = await createConfiguredTransport(this.#config, this.#dependencies, {
        clientCredentialsExtensionEnabled: this.#clientCredentialsExtension.supported,
        onOAuthProvider: (provider) => {
          this.#oauthProvider = provider;
        },
        signal: combinedSignal,
      });
      transport = activeTransport;
      if (this.#isStale(generation)) {
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
      if (this.#isStale(generation)) {
        this.#state = "unavailable";
        await activeClient.close().catch(() => undefined);
        return;
      }
      this.#client = activeClient;
      this.#protocolEra = activeClient.getProtocolEra();
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

  #onToolsChanged(error: Error | null): void {
    this.#toolsGeneration++;
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
    try {
      await this.#ensureReady(signal);
      const client = this.#client;
      if (client?.getServerCapabilities()?.prompts === undefined) {
        throw new McpPromptError("mcp_prompt_unavailable");
      }
      return await runWithSafeAuthLogging(
        this.#config.transport.kind === "http" && this.#config.transport.auth !== undefined,
        () =>
          listAllPrompts({
            now: this.#now,
            ...(signal === undefined ? {} : { signal }),
            requestPage: async (cursor, requestSignal) => {
              const onAbort = () => {
                if (this.#protocolEra === "legacy") {
                  void client.close().catch(() => undefined);
                }
              };
              requestSignal.addEventListener("abort", onAbort, { once: true });
              try {
                const result = await client.request(
                  {
                    method: "prompts/list",
                    ...(cursor === undefined ? {} : { params: { cursor } }),
                  },
                  specTypeSchemas.ListPromptsResult,
                  { timeout: this.#config.timeouts.callMs, signal: requestSignal },
                );
                return ListPromptsResultSchema.parse(result);
              } catch (error) {
                onAbort();
                throw error;
              } finally {
                requestSignal.removeEventListener("abort", onAbort);
              }
            },
          }),
      );
    } catch (error) {
      throw this.#promptConnectionError(error);
    }
  }

  /** Retrieves one prompt on this server connection using its current advertised arguments. */
  async getPrompt(
    name: string,
    arguments_: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    try {
      await this.#ensureReady(signal);
      const client = this.#client;
      if (client?.getServerCapabilities()?.prompts === undefined) {
        throw new McpPromptError("mcp_prompt_unavailable");
      }
      const params = {
        name,
        ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
      };
      const onAbort = () => {
        if (this.#protocolEra === "legacy") {
          void client.close().catch(() => undefined);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const result = await runWithSafeAuthLogging(
        this.#config.transport.kind === "http" && this.#config.transport.auth !== undefined,
        async () => {
          try {
            return await client.request(
              { method: "prompts/get", params },
              specTypeSchemas.GetPromptResult,
              {
                timeout: this.#config.timeouts.callMs,
                ...(signal === undefined ? {} : { signal }),
              },
            );
          } catch (error) {
            onAbort();
            throw error;
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        },
      );
      return GetPromptResultSchema.parse(result);
    } catch (error) {
      throw this.#promptConnectionError(error);
    }
  }

  async #fetchTools(signal?: AbortSignal): Promise<McpTool[]> {
    return [
      ...(await this.#discovery.run((activeSignal) => this.#discoverTools(activeSignal), signal)),
    ];
  }

  #promptConnectionError(error: unknown): McpPromptError {
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
