// SPDX-License-Identifier: Apache-2.0
import type { Transport } from "@modelcontextprotocol/client";
import type { SecretRef, ServerConfig } from "@rovinos/schemas";
import type { OAuthTokenStore } from "./oauth/token-store.js";
import type { McpLogger } from "./transports.js";

/** Observable lifecycle state for one MCP server connection. */
export type McpConnectionState = "connecting" | "ready" | "unavailable";

/** Dependencies injected at the connection boundary. */
export interface McpConnectionDependencies {
  /** Resolves validated server secret references when a transport is created. */
  readonly resolveSecret: (ref: SecretRef, signal?: AbortSignal) => Promise<string>;
  /** Optional logger that accepts only safe codes and stderr byte counts. */
  readonly logger?: McpLogger;
  /** Encrypted per-server credentials used by configured OAuth HTTP transports. */
  readonly oauthTokenStore?: OAuthTokenStore;
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
