// SPDX-License-Identifier: Apache-2.0
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { OAuthDiscoveryConfig } from "@rovinos/schemas";
import { isAllowedOAuthDiscoveryDestination } from "./discovery-policy.js";

/** Maximum protected-resource metadata response size, in bytes. */
export const MAX_OAUTH_DISCOVERY_BYTES = 2 * 1024 * 1024;
/** Total timeout across DNS, redirects, connections, and metadata reading. */
export const MAX_OAUTH_DISCOVERY_TIMEOUT_MS = 20_000;
/** Maximum number of redirects across both discovery requests. */
export const MAX_OAUTH_DISCOVERY_REDIRECTS = 5;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/** One response from a destination-policy checked OAuth discovery hop. */
export interface OAuthDiscoveryResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: IncomingMessage;
}

/** Injectable DNS resolver used by deterministic transport tests. */
export interface OAuthDiscoveryTransportDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

interface Operation {
  readonly signal: AbortSignal;
  readonly redirects: { count: number };
  readonly cleanup: () => void;
  throwIfAborted(): void;
}

function normalizeHost(host: string): string {
  return host.replaceAll(/^\[|\]$/gu, "").replaceAll(/\.$/u, "").toLowerCase();
}

function createOperation(externalSignal?: AbortSignal): Operation {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MAX_OAUTH_DISCOVERY_TIMEOUT_MS);
  const abortFromCaller = (): void => {
    controller.abort();
  };
  if (externalSignal?.aborted === true) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    redirects: { count: 0 },
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
    throwIfAborted: () => {
      if (timedOut) {
        throw new Error("protected_resource_probe_failed");
      }
      if (externalSignal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    },
  };
}

function raceAbort<Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("protected_resource_probe_failed"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function resolveAddresses(
  hostname: string,
  operation: Operation,
  dependencies: OAuthDiscoveryTransportDependencies,
): Promise<readonly string[]> {
  const normalized = normalizeHost(hostname);
  if (isIP(normalized) !== 0) {
    return [normalized];
  }
  const resolve =
    dependencies.resolve ??
    (async (host: string) =>
      (await dnsLookup(host, { all: true, order: "verbatim" })).map(({ address }) => address));
  try {
    const addresses = await raceAbort(resolve(normalized), operation.signal);
    operation.throwIfAborted();
    return addresses;
  } catch {
    operation.throwIfAborted();
    throw new Error("protected_resource_probe_failed");
  }
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

function requestOneHop(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<OAuthDiscoveryResponse> {
  return new Promise((resolve, reject) => {
    const common = {
      method: "GET",
      headers: { accept: "application/json" },
      agent: false as const,
      lookup: pinnedLookup(address),
      signal,
    };
    const request =
      url.protocol === "https:"
        ? httpsRequest(url, {
            ...common,
            ...(isIP(normalizeHost(url.hostname)) === 0
              ? { servername: normalizeHost(url.hostname) }
              : {}),
          })
        : httpRequest(url, common);
    request.once("error", () => {
      reject(new Error("protected_resource_probe_failed"));
    });
    request.once("response", (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
      });
    });
    request.end();
  });
}

/** Requests one destination at a time and revalidates every manual redirect. */
export async function requestOAuthDiscovery(
  initialUrl: URL,
  policy: OAuthDiscoveryConfig,
  operation: Operation,
  dependencies: OAuthDiscoveryTransportDependencies,
): Promise<OAuthDiscoveryResponse | undefined> {
  let url = initialUrl;
  const redirects = operation.redirects;
  while (true) {
    operation.throwIfAborted();
    const addresses = await resolveAddresses(url.hostname, operation, dependencies);
    if (!isAllowedOAuthDiscoveryDestination(url, policy, addresses)) {
      return undefined;
    }
    const address = addresses[0] ?? "";
    if (address === "") {
      return undefined;
    }
    const response = await requestOneHop(url, address, operation.signal);
    if (!redirectStatuses.has(response.status)) {
      return response;
    }
    response.body.destroy();
    const location = response.headers.location;
    if (
      typeof location !== "string" ||
      redirects.count >= MAX_OAUTH_DISCOVERY_REDIRECTS
    ) {
      return undefined;
    }
    redirects.count += 1;
    try {
      url = new URL(location, url);
    } catch {
      return undefined;
    }
  }
}

/** Reads the streamed metadata body under the shared operation byte and time limits. */
export async function readOAuthDiscoveryBody(
  response: IncomingMessage,
  operation: Operation,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      response.removeListener("data", onData);
      response.removeListener("end", onEnd);
      response.removeListener("error", onError);
      operation.signal.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onData = (chunk: Buffer): void => {
      bytesRead += chunk.byteLength;
      if (bytesRead > MAX_OAUTH_DISCOVERY_BYTES) {
        response.destroy();
        finish(new Error("protected_resource_probe_failed"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish();
    };
    const onError = (): void => {
      finish(new Error("protected_resource_probe_failed"));
    };
    const onAbort = (): void => {
      response.destroy();
      finish(new Error("protected_resource_probe_failed"));
    };
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    operation.signal.addEventListener("abort", onAbort, { once: true });
  });
  operation.throwIfAborted();
  return Buffer.concat(chunks).toString("utf8");
}

/** Creates the common deadline and cancellation state for one discovery operation. */
export function createOAuthDiscoveryOperation(signal?: AbortSignal): Operation {
  return createOperation(signal);
}
