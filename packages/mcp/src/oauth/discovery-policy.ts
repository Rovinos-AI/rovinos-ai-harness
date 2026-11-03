// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import type { OAuthDiscoveryConfig } from "@rovinos/schemas";

type AddressClass = "public" | "private" | "loopback" | "blocked";

interface IPv4Range {
  readonly network: readonly number[];
  readonly prefix: number;
}

const privateIPv4Ranges: readonly IPv4Range[] = [
  { network: [10, 0, 0, 0], prefix: 8 },
  { network: [172, 16, 0, 0], prefix: 12 },
  { network: [192, 168, 0, 0], prefix: 16 },
];

const blockedIPv4Ranges: readonly IPv4Range[] = [
  { network: [0, 0, 0, 0], prefix: 8 },
  { network: [100, 64, 0, 0], prefix: 10 },
  { network: [169, 254, 0, 0], prefix: 16 },
  { network: [192, 0, 0, 0], prefix: 24 },
  { network: [198, 18, 0, 0], prefix: 15 },
  { network: [198, 51, 100, 0], prefix: 24 },
  { network: [203, 0, 113, 0], prefix: 24 },
  { network: [224, 0, 0, 0], prefix: 4 },
  { network: [240, 0, 0, 0], prefix: 4 },
];

function normalizeHost(host: string): string {
  return host.replaceAll(/^\[|\]$/gu, "").replaceAll(/\.$/u, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    (isIP(normalized) !== 0 && classifyAddress(normalized) === "loopback")
  );
}

function ipv4CidrMatches(bytes: readonly number[], range: IPv4Range): boolean {
  const wholeBytes = Math.floor(range.prefix / 8);
  if (!bytes.slice(0, wholeBytes).every((byte, index) => byte === range.network[index])) {
    return false;
  }
  const remainingBits = range.prefix % 8;
  if (remainingBits === 0) {
    return true;
  }
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[wholeBytes] ?? 0) & mask) === ((range.network[wholeBytes] ?? 0) & mask);
}

function ipv4Class(address: string): AddressClass {
  const bytes = address.split(".").map(Number);
  if (bytes[0] === 127) {
    return "loopback";
  }
  if (privateIPv4Ranges.some((range) => ipv4CidrMatches(bytes, range))) {
    return "private";
  }
  if (
    bytes[0] >= 224 ||
    blockedIPv4Ranges.some((range) => ipv4CidrMatches(bytes, range))
  ) {
    return "blocked";
  }
  return "public";
}

function ipv6Groups(address: string): readonly number[] {
  const scoped = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /(?:\d{1,3}\.){3}\d{1,3}$/u.exec(scoped)?.[0];
  const normalized = dotted === undefined ? scoped : replaceDottedAddress(scoped, dotted);
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return [];
  }
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) {
    return [];
  }
  return [...left, ...Array.from({ length: omitted }, () => "0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
}

function replaceDottedAddress(address: string, dotted: string): string {
  if (isIP(dotted) !== 4) {
    return address;
  }
  const bytes = dotted.split(".").map(Number);
  const first = (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16);
  const second = (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16);
  return address.replace(dotted, `${first}:${second}`);
}

function validIPv6Groups(groups: readonly number[]): boolean {
  return (
    groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
  );
}

function isIPv6Loopback(groups: readonly number[]): boolean {
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

function isIPv6UniqueLocal(groups: readonly number[]): boolean {
  return (((groups[0] ?? 0) & 0xfe00) === 0xfc00);
}

function isIPv6Special(groups: readonly number[]): boolean {
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  return (
    groups.every((group) => group === 0) ||
    first === 0xff ||
    (first === 0xfe && (second & 0xc000) === 0x8000) ||
    (first & 0xe000) !== 0x2000 ||
    (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) ||
    (first === 0x3fff && (second & 0xfff0) === 0)
  );
}

function embeddedIPv4Class(groups: readonly number[]): AddressClass | undefined {
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const nat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);
  const sixToFour = groups[0] === 0x2002;
  if (!mapped && !nat64 && !sixToFour) {
    return undefined;
  }
  const embedded = mapped || nat64
    ? [groups[6] ?? 0, groups[7] ?? 0]
    : [groups[1] ?? 0, groups[2] ?? 0];
  return ipv4Class(
    `${String((embedded[0] ?? 0) >>> 8)}.${String((embedded[0] ?? 0) & 0xff)}.${String((embedded[1] ?? 0) >>> 8)}.${String((embedded[1] ?? 0) & 0xff)}`,
  );
}

function ipv6Class(address: string): AddressClass {
  const groups = ipv6Groups(address);
  if (!validIPv6Groups(groups)) {
    return "blocked";
  }
  if (isIPv6Loopback(groups)) {
    return "loopback";
  }
  if (isIPv6UniqueLocal(groups)) {
    return "private";
  }
  const embedded = embeddedIPv4Class(groups);
  if (embedded !== undefined) {
    return embedded;
  }
  return isIPv6Special(groups) ? "blocked" : "public";
}

function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    return ipv4Class(address);
  }
  return family === 6 ? ipv6Class(address) : "blocked";
}

function isAllowlisted(url: URL, policy: OAuthDiscoveryConfig): boolean {
  if (policy.allowlist === undefined) {
    return true;
  }
  const host = normalizeHost(url.hostname);
  const port = Number(url.port === "" ? (url.protocol === "https:" ? 443 : 80) : url.port);
  return policy.allowlist.some(
    (entry) => normalizeHost(entry.host) === host && entry.ports.includes(port),
  );
}

function hasAllowedScheme(url: URL, policy: OAuthDiscoveryConfig): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return (
    url.protocol === "http:" &&
    policy.profile === "local-development" &&
    (isLoopbackHost(url.hostname) || isAllowlisted(url, policy))
  );
}

function areAddressesAllowed(
  url: URL,
  policy: OAuthDiscoveryConfig,
  addresses: readonly string[],
): boolean {
  return addresses.every((address) => {
    const classification = classifyAddress(address);
    if (classification === "public") {
      return true;
    }
    if (classification === "private") {
      return policy.profile === "internal";
    }
    if (classification === "loopback") {
      return policy.profile === "local-development" && isAllowlisted(url, policy);
    }
    return false;
  });
}

/** Returns whether every resolved address is permitted for this destination. */
export function isAllowedOAuthDiscoveryDestination(
  url: URL,
  policy: OAuthDiscoveryConfig,
  addresses: readonly string[],
): boolean {
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    addresses.length === 0 ||
    !hasAllowedScheme(url, policy) ||
    !isAllowlisted(url, policy) ||
    (policy.profile === "internal" && (policy.allowlist?.length ?? 0) === 0) ||
    (policy.profile === "production" && url.protocol !== "https:") ||
    (url.protocol === "http:" &&
      addresses.some((address) => classifyAddress(address) !== "loopback"))
  ) {
    return false;
  }
  return areAddressesAllowed(url, policy, addresses);
}
