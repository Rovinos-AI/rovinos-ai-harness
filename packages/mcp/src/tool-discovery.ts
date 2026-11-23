// SPDX-License-Identifier: Apache-2.0
import type { Client } from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import type { McpConnectionDependencies, McpConnectionState } from "./connection-types.js";
import {
  type CachedToolList,
  discoverConnectionTools,
  discoveryConnectionError,
} from "./connection-helpers.js";
import { McpConnectionError } from "./errors.js";
import { DiscoveryTask } from "./discovery-budget.js";
import type { McpTool } from "./tool-list.js";

interface ToolDiscoveryConnection {
  readonly ensureReady: (signal?: AbortSignal) => Promise<void>;
  readonly getClient: () => Client | undefined;
  readonly getProtocolEra: () => "legacy" | "modern" | undefined;
  readonly getState: () => McpConnectionState;
  readonly markUnavailable: () => void;
}

/** Performs bounded tool discovery and caches only complete, current results. */
export class ConnectionToolDiscovery {
  readonly #config: ServerConfig;
  readonly #dependencies: McpConnectionDependencies;
  readonly #connection: ToolDiscoveryConnection;
  readonly #discovery = new DiscoveryTask<McpTool[]>();
  #cachedTools: CachedToolList | undefined;
  #generation = 0;

  constructor(
    config: ServerConfig,
    dependencies: McpConnectionDependencies,
    connection: ToolDiscoveryConnection,
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#connection = connection;
  }

  /** Returns a cached tool catalog or performs a shared, cancellable discovery. */
  async list(signal?: AbortSignal): Promise<McpTool[]> {
    if (signal?.aborted === true) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    await this.#connection.ensureReady(signal);
    const now = this.#dependencies.now?.() ?? Date.now();
    if (this.#cachedTools !== undefined && this.#cachedTools.expiresAt > now) {
      return [...this.#cachedTools.tools];
    }
    return [...(await this.#discovery.run((activeSignal) => this.#discover(activeSignal), signal))];
  }

  /** Invalidates catalog state after a server notification or connection loss. */
  invalidate(): void {
    this.#generation++;
    this.#cachedTools = undefined;
  }

  /** Cancels an in-flight catalog traversal when its client is closed. */
  cancel(): void {
    this.#discovery.cancel();
  }

  async #discover(signal: AbortSignal): Promise<McpTool[]> {
    const client = this.#connection.getClient();
    const generation = this.#generation;
    if (client === undefined || this.#connection.getState() !== "ready") {
      throw new McpConnectionError("mcp_list_tools_failed");
    }
    let listed: Awaited<ReturnType<typeof discoverConnectionTools>>;
    try {
      listed = await discoverConnectionTools(client, this.#config, this.#dependencies, {
        era: this.#connection.getProtocolEra(),
        signal,
      });
    } catch (error) {
      throw discoveryConnectionError(error, () => {
        this.#connection.markUnavailable();
      });
    }
    if (signal.aborted || this.#connection.getClient() !== client) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    if (generation !== this.#generation) {
      throw new McpConnectionError("mcp_list_tools_failed");
    }
    const ttlMs = listed.ttlMs !== undefined && listed.ttlMs > 0 ? listed.ttlMs : 0;
    const now = this.#dependencies.now?.() ?? Date.now();
    this.#cachedTools = { tools: listed.tools, expiresAt: now + ttlMs };
    return [...listed.tools];
  }
}
