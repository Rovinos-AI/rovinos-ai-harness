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
} from "@rovinos/schemas";
import { McpConnectionError } from "./errors.js";
import { McpAuthRequiredError, McpOAuthProvider } from "./oauth/provider.js";
import type { OAuthTokenStore } from "./oauth/token-store.js";

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
        | "mcp_discovery_failed"
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
  /** Encrypted store used only for configured OAuth HTTP transports. */
  readonly oauthTokenStore?: OAuthTokenStore;
  /** Extension availability learned from a previous MCP handshake, if any. */
  readonly clientCredentialsExtensionEnabled?: boolean;
  /** Gives the connection access to the OAuth provider after transport creation. */
  readonly onOAuthProvider?: (provider: McpOAuthProvider) => void;
}

async function resolveValue(
  value: string,
  dependencies: McpTransportDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = SecretRefSchema.safeParse(value);
  return parsed.success ? dependencies.resolveSecret(parsed.data, signal) : value;
}

async function createStdioTransport(options: {
  readonly config: Extract<ServerConfig["transport"], { kind: "stdio" }>;
  readonly serverId: HarnessCode;
  readonly maxResultBytes: number;
  readonly dependencies: McpTransportDependencies;
  readonly signal?: AbortSignal;
}): Promise<StdioClientTransport> {
  const { config, serverId, maxResultBytes, dependencies, signal } = options;
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
    maxBufferSize: maxResultBytes,
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

async function createHttpTransport(options: {
  readonly config: Extract<ServerConfig["transport"], { kind: "http" }>;
  readonly serverId: HarnessCode;
  readonly maxResultBytes: number;
  readonly dependencies: McpTransportDependencies;
  readonly signal?: AbortSignal;
}): Promise<StreamableHTTPClientTransport> {
  const { config, serverId, maxResultBytes, dependencies, signal } = options;
  const headers: Record<string, string> = {};
  for (const [key, ref] of Object.entries(config.headers ?? {})) {
    if (["traceparent", "tracestate", "baggage"].includes(key.toLowerCase())) {
      continue;
    }
    headers[key] = await dependencies.resolveSecret(ref, signal);
  }
  let authProvider: McpOAuthProvider | undefined;
  if (config.auth !== undefined) {
    if (dependencies.oauthTokenStore === undefined) {
      throw new McpAuthRequiredError();
    }
    authProvider = await McpOAuthProvider.create({
      serverId,
      auth: config.auth,
      tokenStore: dependencies.oauthTokenStore,
      resolveSecret: (ref) => dependencies.resolveSecret(ref, signal),
    });
    authProvider.setClientCredentialsExtensionEnabled(
      dependencies.clientCredentialsExtensionEnabled === true,
    );
    dependencies.onOAuthProvider?.(authProvider);
    if (config.auth.grant === "authorization_code" && !authProvider.hasStoredTokens) {
      throw new McpAuthRequiredError();
    }
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
    fetch: createResponseLimitedFetch(maxResultBytes),
    ...(authProvider === undefined ? {} : { authProvider }),
  });
}

/** Bounds the response bytes exposed by Fetch before the SDK parses its response. */
export function createResponseLimitedFetch(maxBytes: number): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchSameOriginRedirects(input, init);
    if (response.body === null) {
      return response;
    }

    const reader = response.body.getReader();
    let bytesRead = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value.byteLength > maxBytes - bytesRead) {
          void reader.cancel().catch(() => undefined);
          controller.error(new McpConnectionError("mcp_response_too_large"));
          return;
        }
        bytesRead += value.byteLength;
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function canFollowRedirect(options: {
  readonly redirects: number;
  readonly inputIsRequest: boolean;
  readonly target: URL;
  readonly initialUrl: URL;
  readonly method: string;
  readonly status: number;
  readonly replayableBody: boolean;
}): boolean {
  const canFollowMethod =
    options.method === "GET" ||
    options.method === "HEAD" ||
    options.status === 307 ||
    options.status === 308;
  return (
    options.redirects < 5 &&
    !options.inputIsRequest &&
    options.target.origin === options.initialUrl.origin &&
    canFollowMethod &&
    options.replayableBody
  );
}

async function fetchSameOriginRedirects(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const initialUrl = new URL(input instanceof Request ? input.url : input.toString());
  const method = init?.method?.toUpperCase() ?? (input instanceof Request ? input.method : "GET");
  const replayableBody = isReplayableBody(init?.body);
  let url = initialUrl;

  for (let redirects = 0; ; redirects++) {
    const response = await globalThis.fetch(url, { ...init, redirect: "manual" });
    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    const target = new URL(location, url);
    if (
      !canFollowRedirect({
        redirects,
        inputIsRequest: input instanceof Request,
        target,
        initialUrl,
        method,
        status: response.status,
        replayableBody,
      })
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("MCP redirect refused");
    }

    await response.body?.cancel().catch(() => undefined);
    url = target;
  }
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
    ? createStdioTransport({
        config: config.transport,
        serverId: config.id,
        maxResultBytes: config.maxResultBytes,
        dependencies,
        ...(signal === undefined ? {} : { signal }),
      })
    : createHttpTransport({
        config: config.transport,
        serverId: config.id,
        maxResultBytes: config.maxResultBytes,
        dependencies,
        ...(signal === undefined ? {} : { signal }),
      });
}
