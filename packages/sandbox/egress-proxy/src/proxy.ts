// SPDX-License-Identifier: Apache-2.0
import { lookup } from "node:dns/promises";
import { resolve } from "node:path";
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
import { parseJson, SandboxEgressAllowEntrySchema, SandboxEgressAllowlistSchema } from "@harness/schemas";
import { z } from "zod";

const DEFAULT_PROXY_PORT = 3128;
const MAX_AUTHORITY_LENGTH = 512;
const CONNECT_TIMEOUT_MS = 10_000;

/** Bounded outcomes emitted by the egress counter sink. */
export type EgressCounterEvent = "egress_allowed" | "egress_denied";

/** Bounded reasons emitted with egress counters. */
export type EgressReason =
  | "allowed"
  | "invalid_request"
  | "not_allowlisted"
  | "private_address"
  | "resolution_failed"
  | "connect_failed";

/** One validated egress destination. */
export type EgressAllowEntry = z.infer<typeof SandboxEgressAllowEntrySchema>;

/** IP resolver used to pin a validated outbound connection to one DNS result. */
export type EgressResolver = (hostname: string) => Promise<readonly string[]>;

/** Socket factory receives only the already-resolved, validated address. */
export type EgressConnector = (address: string, port: number) => Duplex;

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
  /** Receives only bounded counters and reason codes. */
  readonly counter?: (event: EgressCounterEvent, reason: EgressReason) => void;
}

interface Destination {
  readonly hostname: string;
  readonly port: number;
}

interface ResolvedDestination extends Destination {
  readonly address: string;
}

function ipv4Bytes(address: string): readonly number[] {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return [];
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : [];
}

function ipv6Bytes(address: string): readonly number[] {
  const lower = address.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower)?.[1];
  const expanded = dotted === undefined
    ? lower
    : lower.replace(dotted, ipv4Bytes(dotted).map((byte) => byte.toString(16).padStart(2, "0")).join("").match(/.{4}/gu)?.join(":") ?? "");
  const halves = expanded.split("::");
  if (halves.length > 2) {
    return [];
  }
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]?.split(":") ?? [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return [];
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return [];
  }
  return groups.flatMap((group) => [group >>> 8, group & 0xff]);
}

function ipv4Blocked(bytes: readonly number[]): boolean {
  const [first, second] = bytes;
  if (first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

/** Returns true for loopback, link-local, private, unique-local, or multicast addresses. */
export function isBlockedEgressAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return ipv4Blocked(ipv4Bytes(address));
  }
  if (family !== 6) {
    return true;
  }
  const bytes = ipv6Bytes(address);
  if (bytes.length !== 16) {
    return true;
  }
  const mappedIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const compatibleIpv4 = bytes.slice(0, 12).every((byte) => byte === 0);
  if (mappedIpv4 || compatibleIpv4) {
    return ipv4Blocked(bytes.slice(12));
  }
  const unspecified = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  return (
    unspecified ||
    loopback ||
    (bytes[0] === 0xfc || bytes[0] === 0xfd) ||
    (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) ||
    bytes[0] === 0xff
  );
}

function normalizeHost(host: string): string {
  if (host.trim() !== host || host.includes("*") || /[/\\@?#]/u.test(host) || host.length === 0) {
    throw new Error("invalid");
  }
  const input = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const parsed = new URL(`http://${input}/`);
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/") {
    throw new Error("invalid");
  }
  const normalized = parsed.hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized.replace(/\.$/u, "");
}

/** Validates configured hosts and rejects wildcard and private IP-literal entries. */
export function validateEgressAllowlist(entries: readonly EgressAllowEntry[]): readonly EgressAllowEntry[] {
  const normalized = entries.map((entry) => {
    const host = normalizeHost(entry.host);
    if (isIP(host) !== 0 && isBlockedEgressAddress(host)) {
      throw new Error("invalid");
    }
    if (entry.ports.length === 0 || entry.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error("invalid");
    }
    return { host, ports: [...new Set(entry.ports)] };
  });
  return normalized;
}

function parseDestinationAuthority(authority: string): Destination | undefined {
  if (authority.length === 0 || authority.length > MAX_AUTHORITY_LENGTH) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${authority}`);
    const hostname = normalizeHost(parsed.hostname);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.port === ""
    ) {
      return undefined;
    }
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { hostname, port } : undefined;
  } catch {
    return undefined;
  }
}

function parseHttpDestination(request: IncomingMessage): Destination | undefined {
  if (request.url === undefined || request.url.length > 8_192) {
    return undefined;
  }
  try {
    const parsed = new URL(request.url);
    const hostname = normalizeHost(parsed.hostname);
    const port = parsed.port === "" ? 80 : Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      return undefined;
    }
    return { hostname, port };
  } catch {
    return undefined;
  }
}

function isAllowlisted(destination: Destination, entries: readonly EgressAllowEntry[]): boolean {
  return entries.some(
    (entry) => entry.host === destination.hostname && entry.ports.includes(destination.port),
  );
}

async function systemResolve(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

async function resolveDestination(
  destination: Destination,
  entries: readonly EgressAllowEntry[],
  resolver: EgressResolver,
): Promise<ResolvedDestination | EgressReason> {
  if (!isAllowlisted(destination, entries)) {
    return "not_allowlisted";
  }
  try {
    const addresses = await resolver(destination.hostname);
    if (addresses.length === 0) {
      return "resolution_failed";
    }
    if (addresses.some(isBlockedEgressAddress)) {
      return "private_address";
    }
    const address = addresses[0];
    if (address === undefined || isIP(address) === 0) {
      return "resolution_failed";
    }
    return { ...destination, address };
  } catch {
    return "resolution_failed";
  }
}

function defaultCounter(event: EgressCounterEvent, reason: EgressReason): void {
  process.stdout.write(`${JSON.stringify({ counter: event, reason })}\n`);
}

function denied(response: ServerResponse, reason: EgressReason, status: number): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end(reason);
}

function connectSocket(address: string, port: number): Socket {
  const socket = createConnection({ host: address, port, family: isIP(address) });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.once("connect", () => socket.setTimeout(0));
  socket.once("timeout", () => socket.destroy());
  return socket;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  allow: readonly EgressAllowEntry[],
  resolver: EgressResolver,
  connector: EgressConnector,
  counter: (event: EgressCounterEvent, reason: EgressReason) => void,
): Promise<void> {
  const destination = parseHttpDestination(request);
  if (destination === undefined) {
    counter("egress_denied", "invalid_request");
    denied(response, "invalid_request", 400);
    return;
  }
  const resolved = await resolveDestination(destination, allow, resolver);
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
  const host = isIP(destination.hostname) === 6 ? `[${destination.hostname}]` : destination.hostname;
  const headers = { ...request.headers };
  const hopByHop = new Set([
    "connection",
    "host",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    ...(request.headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
  for (const header of hopByHop) {
    delete headers[header];
  }
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
      upstreamResponse.pipe(response);
    },
  );
  upstream.once("error", () => {
    if (!countedAllowed) {
      counter("egress_denied", "connect_failed");
    }
    if (!response.headersSent) {
      denied(response, "connect_failed", 502);
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
  response.once("close", () => socket.destroy());
}

async function handleConnectRequest(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  allow: readonly EgressAllowEntry[],
  resolver: EgressResolver,
  connector: EgressConnector,
  counter: (event: EgressCounterEvent, reason: EgressReason) => void,
): Promise<void> {
  const destination = parseDestinationAuthority(request.url ?? "");
  if (destination === undefined) {
    counter("egress_denied", "invalid_request");
    client.end("HTTP/1.1 400 invalid_request\r\nConnection: close\r\n\r\n");
    return;
  }
  const resolved = await resolveDestination(destination, allow, resolver);
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
      upstream.once("connect", resolve);
      upstream.once("error", reject);
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
  const resolver = options.resolve ?? systemResolve;
  const connector = options.connect ?? connectSocket;
  const counter = options.counter ?? defaultCounter;
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, allow, resolver, connector, counter);
  });
  server.on("connect", (request, client, head) => {
    void handleConnectRequest(request, client, head, allow, resolver, connector, counter);
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
    throw new Error("invalid");
  }
  const allow = parseJson(SandboxEgressAllowlistSchema, text);
  if (allow.length === 0) {
    throw new Error("invalid");
  }
  validateEgressAllowlist(allow);
  const port = Number(process.env.SANDBOX_EGRESS_PROXY_PORT ?? DEFAULT_PROXY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid");
  }
  return createEgressProxy({
    allow,
    port,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
  });
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  startEgressProxy();
}
