// SPDX-License-Identifier: Apache-2.0
import type { Client } from "@modelcontextprotocol/client";
import type { ServerConfig } from "@rovinos/schemas";
import { McpConnectionError } from "./errors.js";
import { abortable } from "./discovery-budget.js";
import { ResourceUriAccess } from "./resource-access.js";
import {
  type McpResource,
  type McpResourceRead,
  type ResourceOperationOptions,
} from "./resource-access.js";
import { createTimedSignal } from "./resource-semaphore.js";

type EnsureReady = (signal?: AbortSignal) => Promise<void>;
type ProtocolEra = "legacy" | "modern" | undefined;

type ResourceSubscription =
  | { readonly era: "legacy" }
  | {
      readonly era: "modern";
      readonly subscription: Awaited<ReturnType<Client["listen"]>>;
    };

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Implements resource operations for one already-configured MCP server connection. */
export class ResourceConnection {
  readonly #config: ServerConfig;
  readonly #access: ResourceUriAccess;
  readonly #subscriptions = new Map<string, ResourceSubscription>();
  #client: Client | undefined;
  #era: ProtocolEra = undefined;
  #generation = 0;

  constructor(config: ServerConfig) {
    this.#config = config;
    this.#access = new ResourceUriAccess(config.resourceUriGrants);
  }

  /** Attaches invalidation handlers to the connected client without declaring client resources. */
  attach(client: Client, era: ProtocolEra): void {
    this.#generation++;
    this.#client = client;
    this.#era = era;
    client.setNotificationHandler("notifications/resources/list_changed", () => {
      this.#generation++;
    });
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      if (this.#access.findGrant(notification.params.uri) !== undefined) {
        this.#generation++;
      }
    });
  }

  /** Invalidates in-flight work after a connection closes or a server resource changes. */
  invalidate(): void {
    this.#generation++;
    this.#subscriptions.clear();
  }

  /** Closes modern subscription streams and releases retained resource URIs. */
  async close(): Promise<void> {
    this.#generation++;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#client = undefined;
    this.#era = undefined;
    await Promise.all(
      subscriptions.flatMap((subscription) =>
        subscription.era === "modern"
          ? [subscription.subscription.close().catch(() => undefined)]
          : [],
      ),
    );
  }

  /** Lists granted resources after tokenizing all returned server-provided strings. */
  async list(options: ResourceOperationOptions, ensureReady: EnsureReady): Promise<McpResource[]> {
    if (!this.#access.hasGrants) {
      throw new McpConnectionError("mcp_resource_access_denied");
    }
    if (isSignalAborted(options.signal)) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    const client = await this.#readyClient(ensureReady, options.signal);
    const generation = this.#generation;
    return this.#access.list(client, {
      serverId: this.#config.id,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      tokenizeText: options.tokenizeText,
      assertGeneration: () => {
        this.#assertGeneration(generation);
      },
    });
  }

  /** Reads a complete request batch and never returns partial content. */
  async read(
    uris: readonly string[],
    options: ResourceOperationOptions,
    ensureReady: EnsureReady,
  ): Promise<McpResourceRead[]> {
    const authorizedUris = this.#access.authorize(uris);
    if (authorizedUris.length === 0) {
      return [];
    }
    if (isSignalAborted(options.signal)) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    const client = await this.#readyClient(ensureReady, options.signal);
    const generation = this.#generation;
    return this.#access.read(client, authorizedUris, {
      serverId: this.#config.id,
      maxResultBytes: this.#config.maxResultBytes,
      callTimeoutMs: this.#config.timeouts.callMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      tokenizeText: options.tokenizeText,
      assertGeneration: () => {
        this.#assertGeneration(generation);
      },
    });
  }

  /** Subscribes only when the server declares resource subscriptions. */
  async subscribe(
    uri: string,
    signal: AbortSignal | undefined,
    ensureReady: EnsureReady,
  ): Promise<void> {
    const [authorizedUri] = this.#access.authorize([uri]);
    if (authorizedUri === undefined) {
      throw new McpConnectionError("mcp_resource_uri_invalid");
    }
    if (isSignalAborted(signal)) {
      throw new McpConnectionError("mcp_discovery_cancelled");
    }
    const client = await this.#readyClient(ensureReady, signal);
    if (client.getServerCapabilities()?.resources?.subscribe !== true) {
      throw new McpConnectionError("mcp_resource_subscription_unavailable");
    }
    if (this.#subscriptions.has(authorizedUri)) {
      return;
    }
    const operation = createTimedSignal(signal, this.#config.timeouts.callMs);
    try {
      if (this.#era === "modern") {
        const subscription = await client.listen(
          { resourceSubscriptions: [authorizedUri] },
          { signal: operation.signal },
        );
        this.#subscriptions.set(authorizedUri, { era: "modern", subscription });
      } else {
        await abortable(
          () => client.subscribeResource({ uri: authorizedUri }, { signal: operation.signal }),
          operation.signal,
        );
        this.#subscriptions.set(authorizedUri, { era: "legacy" });
      }
    } catch {
      if (isSignalAborted(signal)) {
        throw new McpConnectionError("mcp_discovery_cancelled");
      }
      if (operation.timeout.signal.aborted) {
        throw new McpConnectionError("mcp_resource_timeout");
      }
      throw new McpConnectionError("mcp_resource_subscription_unavailable");
    } finally {
      clearTimeout(operation.timer);
    }
  }

  /** Unsubscribes from one previously authorized resource. */
  async unsubscribe(uri: string, signal?: AbortSignal): Promise<void> {
    const [authorizedUri] = this.#access.authorize([uri]);
    if (authorizedUri === undefined) {
      throw new McpConnectionError("mcp_resource_uri_invalid");
    }
    const subscription = this.#subscriptions.get(authorizedUri);
    if (subscription === undefined) {
      return;
    }
    const client = this.#client;
    if (client === undefined) {
      this.#subscriptions.delete(authorizedUri);
      return;
    }
    try {
      if (subscription.era === "modern") {
        await subscription.subscription.close();
      } else {
        await client.unsubscribeResource(
          { uri: authorizedUri },
          signal === undefined ? {} : { signal },
        );
      }
      this.#subscriptions.delete(authorizedUri);
    } catch {
      if (isSignalAborted(signal)) {
        throw new McpConnectionError("mcp_discovery_cancelled");
      }
      throw new McpConnectionError("mcp_resource_subscription_unavailable");
    }
  }

  async #readyClient(ensureReady: EnsureReady, signal?: AbortSignal): Promise<Client> {
    await ensureReady(signal);
    const client = this.#client;
    if (client?.getServerCapabilities()?.resources === undefined) {
      throw new McpConnectionError("mcp_resources_unavailable");
    }
    return client;
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation) {
      throw new McpConnectionError("mcp_resources_changed");
    }
  }
}
