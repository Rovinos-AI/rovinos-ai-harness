// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  type Code as HarnessCode,
  type DoctorCheckStatus,
  type ServerConfig,
} from "@harness/schemas";
import {
  McpConnection,
  McpConnectionError,
  type McpConnectionDependencies,
  type McpConnectionState,
  type McpTool,
} from "./connection.js";
import type { McpLogger } from "./transports.js";

/** Context needed by one configured-server doctor diagnostic. */
export interface ServersReachableCheckContext {
  /** Cancellation signal supplied by the doctor runner. */
  readonly signal?: AbortSignal;
}

/** Doctor check compatible with the core doctor registry. */
export interface ServersReachableCheck {
  /** Stable identifier distinguishing this configured server. */
  readonly id: HarnessCode;
  /** Human-readable check title. */
  readonly title: string;
  /** Attempts one connection and returns safe per-server status metadata. */
  run(context: ServersReachableCheckContext): Promise<DoctorCheckStatus>;
}

/** Safe state summary for one configured MCP server. */
export interface McpServerState {
  /** Configured server identifier. */
  readonly serverId: Code;
  /** Current connection lifecycle state. */
  readonly state: McpConnectionState;
  /** Negotiated era while the server is connected. */
  readonly protocolEra?: "legacy" | "modern";
}

/** Safe error raised when a server id is not in this pool. */
export class McpPoolError extends HarnessError {
  override readonly code = "mcp_server_not_found";

  /** Creates an error that does not include the requested server id. */
  constructor() {
    super("mcp_server_not_found");
  }
}

/** Owns and coordinates connections for the configured MCP servers. */
export class McpPool {
  readonly #connections: ReadonlyMap<HarnessCode, McpConnection>;
  readonly #logger: McpLogger | undefined;

  /**
   * Creates one managed connection for every validated server configuration.
   *
   * @param configs - Validated MCP server configurations.
   * @param dependencies - Shared resolver, logger, and reconnect hooks.
   */
  constructor(configs: readonly ServerConfig[], dependencies: McpConnectionDependencies) {
    this.#logger = dependencies.logger;
    this.#connections = new Map(
      configs.map((config) => [config.id, new McpConnection(config, dependencies)]),
    );
  }

  /** Eagerly connects to all servers in parallel while tolerating individual failures. */
  async connect(): Promise<void> {
    await Promise.all(
      [...this.#connections.entries()].map(async ([serverId, connection]) => {
        try {
          await connection.connect();
        } catch (error) {
          this.#logFailure(serverId, error);
        }
      }),
    );
  }

  /** Returns a safe snapshot of every configured connection state. */
  states(): McpServerState[] {
    return [...this.#connections.entries()].map(([serverId, connection]) => ({
      serverId,
      state: connection.state,
      ...(connection.protocolEra === undefined ? {} : { protocolEra: connection.protocolEra }),
    }));
  }

  /** Returns the discovered tools for one server. */
  listTools(serverId: HarnessCode): Promise<McpTool[]> {
    return this.#getConnection(serverId).listTools();
  }

  /**
   * Returns a managed connection.
   *
   * @param serverId - Configured server id.
   * @returns The corresponding connection.
   * @throws McpPoolError when the id is not configured.
   */
  connection(serverId: HarnessCode): McpConnection {
    return this.#getConnection(serverId);
  }

  /** Closes all server connections in parallel. */
  async close(): Promise<void> {
    await Promise.all([...this.#connections.values()].map((connection) => connection.close()));
  }

  #getConnection(serverId: HarnessCode): McpConnection {
    const connection = this.#connections.get(serverId);
    if (connection === undefined) {
      throw new McpPoolError();
    }
    return connection;
  }

  #logFailure(serverId: HarnessCode, error: unknown): void {
    const code =
      error instanceof McpConnectionError &&
      (error.code === "mcp_connect_failed" || error.code === "mcp_connect_timeout")
        ? error.code
        : "mcp_pool_connect_failed";
    this.#logger?.log({
      code,
      serverId,
    });
  }
}

/**
 * Creates one safe reachability check per configured server.
 *
 * @param configs - Validated MCP server configurations.
 * @param dependencies - Secret resolver and safe logger.
 * @returns Doctor checks whose details identify each server without exposing transport data.
 */
export function createServersReachableChecks(
  configs: readonly ServerConfig[],
  dependencies: McpConnectionDependencies,
): ServersReachableCheck[] {
  if (configs.length === 0) {
    return [
      {
        id: Code.parse("servers_reachable"),
        title: "MCP servers reachable",
        run: () => Promise.resolve({ status: "ok", code: Code.parse("servers_reachable") }),
      },
    ];
  }
  return configs.map((config, index) => ({
    id: Code.parse(`servers_reachable_${String(index)}`),
    title: `MCP server ${config.id} reachable`,
    run: async ({ signal }) => {
      const connection = new McpConnection(config, dependencies);
      try {
        if (signal?.aborted === true) {
          return { status: "fail", code: Code.parse("check_timeout"), detail: config.id };
        }
        await connection.connect(signal);
        return { status: "ok", code: Code.parse("servers_reachable"), detail: config.id };
      } catch (error) {
        const failureCode = error instanceof McpConnectionError ? error.code : "mcp_connect_failed";
        return {
          status: "fail",
          code: Code.parse(failureCode),
          detail: config.id,
        };
      } finally {
        await connection.close();
      }
    },
  }));
}
