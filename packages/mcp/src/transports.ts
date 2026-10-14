// SPDX-License-Identifier: Apache-2.0
import { StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  SecretRefSchema,
  type Code as HarnessCode,
  type SecretRef,
  type ServerConfig,
} from "@harness/schemas";

/** Safe log events emitted by MCP transport and connection lifecycle operations. */
export type McpLogEvent =
  | { readonly code: "mcp_stderr"; readonly serverId: HarnessCode; readonly bytes: number }
  | {
      readonly code: "mcp_tools_excluded";
      readonly serverId: HarnessCode;
      readonly count: number;
    }
  | {
      readonly code:
        | "mcp_connect_failed"
        | "mcp_connect_timeout"
        | "mcp_tools_refresh_failed"
        | "mcp_pool_connect_failed";
      readonly serverId: HarnessCode;
    };

/** Receives only bounded MCP status codes and integer stderr byte counts. */
export interface McpLogger {
  /** Emits one safe event without server-provided text. */
  log(event: McpLogEvent): void;
}

/** Dependencies used to resolve transport-bound credentials and process settings. */
export interface McpTransportDependencies {
  /** Resolves a validated secret reference at connection time. */
  readonly resolveSecret: (ref: SecretRef, signal?: AbortSignal) => Promise<string>;
  /** Environment used only for the explicitly permitted PATH inheritance. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional safe logger; stderr text is discarded after counting bytes. */
  readonly logger?: McpLogger;
}

async function resolveValue(
  value: string,
  dependencies: McpTransportDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = SecretRefSchema.safeParse(value);
  return parsed.success ? dependencies.resolveSecret(parsed.data, signal) : value;
}

async function createStdioTransport(
  config: Extract<ServerConfig["transport"], { kind: "stdio" }>,
  serverId: HarnessCode,
  dependencies: McpTransportDependencies,
  signal?: AbortSignal,
): Promise<StdioClientTransport> {
  const environment: Record<string, string> = {};
  // The SDK spreads getDefaultEnvironment() under `env`; own keys set to undefined mask those
  // defaults (spawn drops undefined values), so nothing is inherited unless configured below.
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    Reflect.set(environment, key, undefined);
  }
  const env = dependencies.env ?? process.env;
  if (config.inheritEnv && env.PATH !== undefined) {
    environment.PATH = env.PATH;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    environment[key] = await resolveValue(value, dependencies, signal);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: environment,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > 0) {
      dependencies.logger?.log({ code: "mcp_stderr", serverId, bytes });
    }
  });
  return transport;
}

async function createHttpTransport(
  config: Extract<ServerConfig["transport"], { kind: "http" }>,
  dependencies: McpTransportDependencies,
  signal?: AbortSignal,
): Promise<StreamableHTTPClientTransport> {
  const headers: Record<string, string> = {};
  for (const [key, ref] of Object.entries(config.headers ?? {})) {
    if (["traceparent", "tracestate", "baggage"].includes(key.toLowerCase())) {
      continue;
    }
    headers[key] = await dependencies.resolveSecret(ref, signal);
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
}

/**
 * Creates the official SDK transport for one validated server configuration.
 *
 * Stdio receives an empty environment unless `inheritEnv` is enabled; even then,
 * only `PATH` and explicitly configured variables are passed to the child.
 *
 * @param config - Validated server configuration.
 * @param dependencies - Secret resolver, optional logger, and environment source.
 * @param signal - Optional connection timeout/cancellation signal.
 * @returns A ready-to-connect MCP SDK transport.
 */
export function createMcpTransport(
  config: ServerConfig,
  dependencies: McpTransportDependencies,
  signal?: AbortSignal,
): Promise<Transport> {
  return config.transport.kind === "stdio"
    ? createStdioTransport(config.transport, config.id, dependencies, signal)
    : createHttpTransport(config.transport, dependencies, signal);
}
