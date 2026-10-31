// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";

/** URL policy applied before an elicitation URL is presented to a human. */
export interface ElicitationUrlOptions {
  readonly requireHttps?: boolean;
  readonly urlAllowHosts?: readonly string[];
}

/** Safe result of checking an untrusted elicitation URL. */
export type ElicitationUrlCheck =
  | { readonly accepted: true; readonly suspicious: boolean }
  | {
      readonly accepted: false;
      readonly reason:
        "invalid" | "scheme" | "credentials" | "https_required" | "ip_literal" | "host_not_allowed";
    };

function normalizedHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const unwrapped =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return isIP(unwrapped) === 6 ? unwrapped : domainToASCII(normalized);
}

function isLoopback(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return (
    unwrapped === "localhost" ||
    unwrapped.endsWith(".localhost") ||
    (isIP(unwrapped) === 4 && unwrapped.startsWith("127.")) ||
    (isIP(unwrapped) === 6 && unwrapped === "::1")
  );
}

function isMixedScript(hostname: string): boolean {
  const unicodeHostname = domainToUnicode(hostname);
  const scripts = [
    /\p{Script=Latin}/u,
    /\p{Script=Cyrillic}/u,
    /\p{Script=Greek}/u,
    /\p{Script=Hebrew}/u,
    /\p{Script=Arabic}/u,
    /\p{Script=Han}/u,
    /\p{Script=Hiragana}/u,
    /\p{Script=Katakana}/u,
  ];
  return scripts.filter((script) => script.test(unicodeHostname)).length > 1;
}

function normalizedAllowlist(hosts: readonly string[]): ReadonlySet<string> {
  return new Set(
    hosts.flatMap((host) => {
      const normalized = normalizedHostname(host);
      return normalized.length > 0 ? [normalized] : [];
    }),
  );
}

function hasUrlCredentials(value: string): boolean {
  const authorityStart = value.indexOf("//");
  if (authorityStart < 0) {
    return false;
  }
  const authority = value.slice(authorityStart + 2).split(/[/?#]/u, 1)[0] ?? "";
  return authority.includes("@");
}

function hostPolicy(
  hostname: string,
  options: ElicitationUrlOptions,
): ElicitationUrlCheck | undefined {
  const allowedHosts = normalizedAllowlist(options.urlAllowHosts ?? []);
  const allowlisted = allowedHosts.has(hostname);
  if (isIP(hostname) !== 0 && !allowlisted) {
    return { accepted: false, reason: "ip_literal" };
  }
  if (options.urlAllowHosts !== undefined && !allowlisted) {
    return { accepted: false, reason: "host_not_allowed" };
  }
  return undefined;
}

function isHttpsAllowed(url: URL, hostname: string, options: ElicitationUrlOptions): boolean {
  return url.protocol === "https:" || (isLoopback(hostname) && options.requireHttps === false);
}

function suspiciousHost(hostname: string): boolean {
  return hostname.includes("xn--") || isMixedScript(hostname);
}

/**
 * Checks an untrusted URL without performing network activity or opening it.
 *
 * Host allowlist entries match a normalized hostname exactly. Invalid URLs are declined without
 * being presented; accepted internationalized or mixed-script hosts are marked suspicious.
 *
 * @param value - URL supplied by an MCP server.
 * @param options - Global URL policy; HTTPS is required by default.
 * @returns Whether the URL may be presented and whether it needs a host warning.
 */
export function checkElicitationUrl(
  value: string,
  options: ElicitationUrlOptions = {},
): ElicitationUrlCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { accepted: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { accepted: false, reason: "scheme" };
  }
  if (url.username.length > 0 || url.password.length > 0 || hasUrlCredentials(value)) {
    return { accepted: false, reason: "credentials" };
  }
  const hostname = normalizedHostname(url.hostname);
  if (hostname.length === 0) {
    return { accepted: false, reason: "invalid" };
  }
  const hostRejection = hostPolicy(hostname, options);
  if (hostRejection !== undefined) {
    return hostRejection;
  }
  if (!isHttpsAllowed(url, hostname, options)) {
    return { accepted: false, reason: "https_required" };
  }
  return {
    accepted: true,
    suspicious: suspiciousHost(hostname),
  };
}
