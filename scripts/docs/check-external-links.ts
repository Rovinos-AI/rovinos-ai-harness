// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { collectMarkdownLinks, type LinkIssue } from "./check-links.ts";
import type { MarkdownSource } from "./markdown.ts";

interface LinkLocation {
  readonly path: string;
  readonly line: number;
}

/**
 * Checks deduplicated HTTP links with bounded parallelism and per-request timeouts.
 *
 * @param sources - Markdown sources.
 * @param fetcher - HTTP implementation, injectable for tests.
 * @returns External links that could not be reached successfully.
 */
export async function checkExternalLinks(
  sources: readonly MarkdownSource[],
  fetcher: typeof fetch = fetch,
): Promise<LinkIssue[]> {
  const links = collectExternalUrls(sources);
  const entries = [...links.entries()];
  const issues: LinkIssue[] = [];
  for (let index = 0; index < entries.length; index += 10) {
    const batch = entries.slice(index, index + 10);
    const results = await Promise.all(
      batch.map(async ([destination, location]) =>
        checkExternalUrl(destination, location, fetcher),
      ),
    );
    issues.push(...results.flatMap((issue) => (issue === undefined ? [] : [issue])));
  }
  return issues;
}

function collectExternalUrls(sources: readonly MarkdownSource[]): Map<string, LinkLocation> {
  const links = new Map<string, LinkLocation>();
  for (const source of sources) {
    for (const { destination, line } of collectMarkdownLinks(source.contents)) {
      if (/^https?:\/\//iu.test(destination) && destination.length > 0 && !links.has(destination)) {
        links.set(destination, { path: source.path, line });
      }
    }
  }
  return links;
}

async function checkExternalUrl(
  destination: string,
  location: LinkLocation,
  fetcher: typeof fetch,
): Promise<LinkIssue | undefined> {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return { ...location, reason: "invalid external HTTP URL" };
  }
  if (isDisallowedHost(url)) {
    return { ...location, reason: "external URL host is not allowed" };
  }
  try {
    let response = await fetcher(url, requestOptions("HEAD"));
    if (response.status === 405 || response.status === 501) {
      response = await fetcher(url, requestOptions("GET"));
    }
    return response.status >= 200 && response.status < 400
      ? undefined
      : {
          ...location,
          reason: `external HTTP link returned status ${String(response.status)}`,
        };
  } catch {
    return { ...location, reason: "external HTTP link could not be reached" };
  }
}

function isDisallowedHost(url: URL): boolean {
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, "");
  return (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  );
}

function requestOptions(method: "GET" | "HEAD"): RequestInit {
  return {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...(method === "GET" ? { headers: { Range: "bytes=0-0" } } : {}),
  };
}
