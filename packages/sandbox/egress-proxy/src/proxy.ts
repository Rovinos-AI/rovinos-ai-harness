// SPDX-License-Identifier: Apache-2.0
import { resolve as resolvePath } from "node:path";
import {
  Agent as HttpAgent,
  request as createHttpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP, createConnection, type Socket } from "node:net";
import process from "node:process";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { ContractError, parseJson, SandboxEgressAllowlistSchema } from "@harness/schemas";
import {
  EgressProxyConfigurationError,
  formatEgressProxyConfigurationError,
  type EgressAllowEntry,
  type EgressConnector,
  type EgressCounterEvent,
  type EgressProxyConfigurationErrorCode,
  type EgressReason,
  type EgressResolver,
} from "./contracts.js";
import {
  parseConnectDestination,
  parseHttpDestination,
  resolveEgressHostname,
  resolveEgressDestination,
  validateEgressAllowlist,
} from "./policy.js";

export { EgressProxyConfigurationError, formatEgressProxyConfigurationError } from "./contracts.js";
export type {
  EgressAllowEntry,
  EgressCounterEvent,
  EgressProxyConfigurationErrorCode,
  EgressReason,
} from "./contracts.js";
export { isBlockedEgressAddress, validateEgressAllowlist } from "./policy.js";

const DEFAULT_PROXY_PORT = 3128;
const CONNECT_TIMEOUT_MS = 10_000;

/** Egress proxy construction options. */
export interface EgressProxyOptions {
  /** Exact host and port pairs to permit. */
  readonly allow: readonly EgressAllowEntry[];
  /** Bind address for the HTTP proxy. */
  readonly host?: string;
  /** Bind port for the HTTP proxy. */
  readonly port?: number;
  /** Optional Unix socket path for local service tests. */
  readonly socketPath?: string;
  /** DNS resolver; injectable for deterministic tests. */
  readonly resolve?: EgressResolver;
  /** Destination connector; injectable for deterministic tests. */
  readonly connect?: EgressConnector;
  /** Outbound CONNECT establishment timeout in milliseconds. */
  readonly connectTimeoutMs?: number;
  /** Receives only bounded counters and reason codes. */
  readonly counter?: (event: EgressCounterEvent, reason: EgressReason) => void;
}

interface ProxyRequestContext {
  readonly allow: readonly EgressAllowEntry[];
  readonly resolver: EgressResolver;
  readonly connector: EgressConnector;
  readonly counter: (event: EgressCounterEvent, reason: EgressReason) => void;
  readonly connectTimeoutMs: number;
}

function defaultCounter(event: EgressCounterEvent, reason: EgressReason): void {
  process.stdout.write(`${JSON.stringify({ counter: event, reason })}\n`);
}

function denied(response: ServerResponse, reason: EgressReason, status: number): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end(reason);
}

function hopByHopHeaders(connectionHeader: string | undefined): Set<string> {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(connectionHeader ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
}

function forwardedResponseHeaders(
  headers: IncomingMessage["headers"],
  connectionHeader: string | undefined,
): Record<string, string | string[] | undefined> {
  const hopByHop = hopByHopHeaders(connectionHeader);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHop.has(name.toLowerCase())),
  );
}

function pipeUpstreamResponse(upstreamResponse: IncomingMessage, response: ServerResponse): void {
  response.writeHead(
    upstreamResponse.statusCode ?? 502,
    forwardedResponseHeaders(upstreamResponse.headers, upstreamResponse.headers.connection),
  );
  const endResponseOnError = (): void => {
    response.destroy();
  };
  upstreamResponse.once("aborted", endResponseOnError);
  upstreamResponse.once("error", endResponseOnError);
  upstreamResponse.pipe(response);
}

function handleUpstreamRequestError(
  response: ServerResponse,
  countedAllowed: boolean,
  counter: ProxyRequestContext["counter"],
): void {
  if (!countedAllowed) {
    counter("egress_denied", "connect_failed");
  }
  if (!response.headersSent) {
    denied(response, "connect_failed", 502);
  } else {
    response.destroy();
  }
}

function connectSocket(address: string, port: number): Socket {
  const socket = createConnection({ host: address, port, family: isIP(address) });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.once("connect", () => socket.setTimeout(0));
  socket.once("timeout", () => socket.destroy(new Error("outbound connection timed out")));
  return socket;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ProxyRequestContext,
): Promise<void> {
  const { allow, resolver, connector, counter } = context;
  const destination = parseHttpDestination(request);
  if (destination === undefined) {
    counter("egress_denied", "invalid_request");
    denied(response, "invalid_request", 400);
    return;
  }
  const resolved = await resolveEgressDestination(destination, allow, resolver);
  if (typeof resolved === "string") {
    counter("egress_denied", resolved);
    denied(response, resolved, resolved === "not_allowlisted" ? 403 : 502);
    return;
  }
  let socket: Duplex;
  try {
    socket = connector(resolved.address, resolved.port);
  } catch {
    counter("egress_denied", "connect_failed");
    denied(response, "connect_failed", 502);
    return;
  }
  let countedAllowed = false;
  socket.once("connect", () => {
    countedAllowed = true;
    counter("egress_allowed", "allowed");
  });
  const path = new URL(request.url ?? "");
  const host =
    isIP(destination.hostname) === 6 ? `[${destination.hostname}]` : destination.hostname;
  const hopByHop = hopByHopHeaders(request.headers.connection);
  hopByHop.add("host");
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())),
  );
  const agent = new HttpAgent({ keepAlive: false });
  agent.createConnection = () => socket;
  const upstream = createHttpRequest(
    {
      hostname: destination.hostname,
      port: destination.port,
      method: request.method,
      path: `${path.pathname}${path.search}`,
      headers: { ...headers, host: `${host}:${String(destination.port)}`, connection: "close" },
      agent,
    },
    (upstreamResponse) => {
      pipeUpstreamResponse(upstreamResponse, response);
    },
  );
  upstream.once("error", () => {
    handleUpstreamRequestError(response, countedAllowed, counter);
  });
  request.pipe(upstream);
  response.once("close", () => {
    socket.destroy();
  });
}

async function handleConnectRequest(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  context: ProxyRequestContext,
): Promise<void> {
  const { allow, resolver, connector, counter, connectTimeoutMs } = context;
  const destination = parseConnectDestination(request.url ?? "");
  if (destination === undefined) {
    counter("egress_denied", "invalid_request");
    client.end("HTTP/1.1 400 invalid_request\r\nConnection: close\r\n\r\n");
    return;
  }
  const resolved = await resolveEgressDestination(destination, allow, resolver);
  if (typeof resolved === "string") {
    counter("egress_denied", resolved);
    const status = resolved === "not_allowlisted" ? 403 : 502;
    client.end(`HTTP/1.1 ${String(status)} ${resolved}\r\nConnection: close\r\n\r\n`);
    return;
  }
  let upstream: Duplex;
  try {
    upstream = connector(resolved.address, resolved.port);
  } catch {
    counter("egress_denied", "connect_failed");
    client.end("HTTP/1.1 502 connect_failed\r\nConnection: close\r\n\r\n");
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => upstream.destroy(new Error("outbound connection timed out")),
        connectTimeoutMs,
      );
      const settle = (callback: () => void): void => {
        clearTimeout(timeout);
        callback();
      };
      upstream.once("connect", () => {
        settle(resolve);
      });
      upstream.once("error", () => {
        settle(reject);
      });
    });
  } catch {
    counter("egress_denied", "connect_failed");
    client.end("HTTP/1.1 502 connect_failed\r\nConnection: close\r\n\r\n");
    return;
  }
  counter("egress_allowed", "allowed");
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) {
    upstream.write(head);
  }
  client.pipe(upstream);
  upstream.pipe(client);
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
  upstream.once("close", () => client.destroy());
}

/** Creates an HTTP proxy that forwards only pinned, allowlisted public destinations. */
export function createEgressProxy(options: EgressProxyOptions): Server {
  const allow = validateEgressAllowlist(options.allow);
  const resolver = options.resolve ?? resolveEgressHostname;
  const connector = options.connect ?? connectSocket;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const counter = options.counter ?? defaultCounter;
  const context: ProxyRequestContext = {
    allow,
    resolver,
    connector,
    counter,
    connectTimeoutMs,
  };
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, context);
  });
  server.on("connect", (request, client, head) => {
    void handleConnectRequest(request, client, head, context);
  });
  server.requestTimeout = CONNECT_TIMEOUT_MS;
  server.headersTimeout = CONNECT_TIMEOUT_MS;
  if (options.socketPath === undefined) {
    server.listen(options.port ?? DEFAULT_PROXY_PORT, options.host ?? "0.0.0.0");
  } else {
    server.listen(options.socketPath);
  }
  return server;
}

/** Starts the Compose egress proxy with a validated JSON allowlist.
 *
 * @param options - Optional Unix socket path for local service tests.
 * @returns The listening proxy server.
 */
export function startEgressProxy(options: { readonly socketPath?: string } = {}): Server {
  const text = process.env.SANDBOX_EGRESS_ALLOW;
  if (text === undefined) {
    throw new EgressProxyConfigurationError("allowlist_missing");
  }
  let allow: readonly EgressAllowEntry[];
  try {
    allow = parseJson(SandboxEgressAllowlistSchema, text);
  } catch (error) {
    if (error instanceof ContractError) {
      const issuePaths = error.issues.flatMap(({ path }) => path.map(String));
      let code: EgressProxyConfigurationErrorCode = "allowlist_invalid";
      if (issuePaths.includes("host")) {
        code = "allowlist_host_invalid";
      } else if (issuePaths.includes("ports")) {
        code = "allowlist_port_invalid";
      }
      throw new EgressProxyConfigurationError(code);
    }
    throw error;
  }
  if (allow.length === 0) {
    throw new EgressProxyConfigurationError("allowlist_empty");
  }
  validateEgressAllowlist(allow);
  const port = Number(process.env.SANDBOX_EGRESS_PROXY_PORT ?? DEFAULT_PROXY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EgressProxyConfigurationError("proxy_port_invalid");
  }
  return createEgressProxy({
    allow,
    port,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
  });
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
  try {
    startEgressProxy();
  } catch (error) {
    if (!(error instanceof EgressProxyConfigurationError)) {
      throw error;
    }
    process.stderr.write(formatEgressProxyConfigurationError(error));
    process.exitCode = 1;
  }
}
