// SPDX-License-Identifier: Apache-2.0
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { EgressProxyConfigurationError } from "./contracts.js";
import type {
  Destination,
  EgressAllowEntry,
  EgressReason,
  EgressResolver,
  ResolvedDestination,
} from "./contracts.js";

const MAX_AUTHORITY_LENGTH = 512;

interface IPv4Cidr {
  readonly network: readonly number[];
  readonly prefixLength: number;
}

const blockedIPv4Cidrs: readonly IPv4Cidr[] = [
  { network: [0, 0, 0, 0], prefixLength: 8 },
  { network: [10, 0, 0, 0], prefixLength: 8 },
  { network: [100, 64, 0, 0], prefixLength: 10 },
  { network: [127, 0, 0, 0], prefixLength: 8 },
  { network: [169, 254, 0, 0], prefixLength: 16 },
  { network: [172, 16, 0, 0], prefixLength: 12 },
  { network: [192, 0, 0, 0], prefixLength: 24 },
  { network: [192, 168, 0, 0], prefixLength: 16 },
  { network: [198, 18, 0, 0], prefixLength: 15 },
  { network: [224, 0, 0, 0], prefixLength: 3 },
];

function ipv4Bytes(address: string): readonly number[] {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return [];
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : [];
}

function matchesIPv4Cidr(bytes: readonly number[], cidr: IPv4Cidr): boolean {
  const fullBytes = Math.floor(cidr.prefixLength / 8);
  if (!bytes.slice(0, fullBytes).every((byte, index) => byte === cidr.network[index])) {
    return false;
  }
  const remainingBits = cidr.prefixLength % 8;
  if (remainingBits === 0) {
    return true;
  }
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((cidr.network[fullBytes] ?? 0) & mask);
}

function ipv4Blocked(bytes: readonly number[]): boolean {
  return bytes.length !== 4 || blockedIPv4Cidrs.some((cidr) => matchesIPv4Cidr(bytes, cidr));
}

function parseIPv6Groups(value: string | undefined): number[] {
  if (value === undefined || value === "") {
    return [];
  }
  return value.split(":").map((group) => Number.parseInt(group, 16));
}

function expandDottedIPv4(address: string): string {
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)?.[1];
  if (dotted === undefined) {
    return address;
  }
  const bytes = ipv4Bytes(dotted);
  if (bytes.length !== 4) {
    return address;
  }
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return address.replace(dotted, `${hex.slice(0, 4)}:${hex.slice(4)}`);
}

function ipv6Bytes(address: string): readonly number[] {
  const halves = expandDottedIPv4(address.toLowerCase()).split("::");
  if (halves.length > 2) {
    return [];
  }
  const left = parseIPv6Groups(halves[0]);
  const right = parseIPv6Groups(halves[1]);
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return [];
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) {
    return [];
  }
  return groups.flatMap((group) => [group >>> 8, group & 0xff]);
}

function startsWithBytes(bytes: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function embeddedIPv4(bytes: readonly number[]): readonly number[] | undefined {
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (mapped || compatible) {
    return bytes.slice(12);
  }
  if (startsWithBytes(bytes, [0, 100, 255, 155, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return bytes.slice(12);
  }
  if (startsWithBytes(bytes, [0, 100, 255, 155, 0, 1])) {
    return [bytes[6] ?? 0, bytes[7] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0];
  }
  if (startsWithBytes(bytes, [0x20, 0x02])) {
    return bytes.slice(2, 6);
  }
  return undefined;
}

function blockedIPv6SpecialRange(bytes: readonly number[]): boolean {
  const unspecified = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const discardOnly = bytes[0] === 1 && bytes.slice(1, 8).every((byte) => byte === 0);
  const teredo = startsWithBytes(bytes, [0x20, 0x01, 0, 0]);
  const siteLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0;
  const uniqueLocal = bytes[0] === 0xfc || bytes[0] === 0xfd;
  const linkLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  return [
    unspecified,
    loopback,
    discardOnly,
    teredo,
    siteLocal,
    uniqueLocal,
    linkLocal,
    multicast,
  ].some(Boolean);
}

/** Returns true for blocked private, metadata, and special-use destinations. */
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
  const embedded = embeddedIPv4(bytes);
  return embedded === undefined ? blockedIPv6SpecialRange(bytes) : ipv4Blocked(embedded);
}

function normalizeHost(host: string): string {
  if (host.trim() !== host || host.includes("*") || /[/\\@?#]/u.test(host) || host.length === 0) {
    throw new EgressProxyConfigurationError("allowlist_host_invalid");
  }
  const input = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let parsed: URL;
  try {
    parsed = new URL(`http://${input}/`);
  } catch {
    throw new EgressProxyConfigurationError("allowlist_host_invalid");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new EgressProxyConfigurationError("allowlist_host_invalid");
  }
  const normalized = parsed.hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized.replace(/\.$/u, "");
}

/** Validates configured hosts and rejects wildcard and private IP-literal entries. */
export function validateEgressAllowlist(
  entries: readonly EgressAllowEntry[],
): readonly EgressAllowEntry[] {
  const normalized = entries.map((entry) => {
    const host = normalizeHost(entry.host);
    if (isIP(host) !== 0 && isBlockedEgressAddress(host)) {
      throw new EgressProxyConfigurationError("allowlist_host_invalid");
    }
    if (
      entry.ports.length === 0 ||
      entry.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new EgressProxyConfigurationError("allowlist_port_invalid");
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

/**
 * Parses an absolute plain-HTTP proxy request target.
 *
 * @param request - Untrusted incoming proxy request.
 * @returns Parsed destination, or undefined when the request target is invalid.
 */
export function parseHttpDestination(request: IncomingMessage): Destination | undefined {
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

/**
 * Parses a CONNECT authority into a host and port pair.
 *
 * @param authority - Untrusted CONNECT request authority.
 * @returns Parsed destination, or undefined when the authority is invalid.
 */
export function parseConnectDestination(authority: string): Destination | undefined {
  return parseDestinationAuthority(authority);
}

function isAllowlisted(destination: Destination, entries: readonly EgressAllowEntry[]): boolean {
  return entries.some(
    (entry) => entry.host === destination.hostname && entry.ports.includes(destination.port),
  );
}

/** Resolves literals directly and hostnames through the operating-system resolver. */
export async function resolveEgressHostname(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  const addresses = await lookup(hostname, { all: true, order: "verbatim" });
  return addresses.map(({ address }) => address);
}

/** Resolves and validates an allowlisted destination before connection. */
export async function resolveEgressDestination(
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
