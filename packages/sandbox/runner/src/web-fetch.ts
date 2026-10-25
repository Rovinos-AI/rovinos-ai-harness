// SPDX-License-Identifier: Apache-2.0
import { request as createHttpRequest, type IncomingHttpHeaders } from "node:http";
import { request as createHttpsRequest, Agent as HttpsAgent } from "node:https";
import { connect as connectTls } from "node:tls";
import { HarnessError, Id, parseJson, SandboxEgressAllowlistSchema } from "@rovinos/schemas";
import { z } from "zod";
import { htmlToText } from "./html-text.js";
import {
  MAX_WEB_FETCH_BYTES,
  MAX_WEB_FETCH_REDIRECTS,
  WebFetchRequestSchema,
  WebFetchResultSchema,
} from "../../src/web-fetch-contracts.js";
import type { WebFetchRequest, WebFetchResult } from "../../src/web-fetch-contracts.js";
import {
  requestThroughProxy,
  type NativeClientRequest,
  type NativeIncomingMessage,
  type ProxyRequest,
  type ProxyResponse,
  type WebFetchRequester,
  type WebFetchTransport,
  type ProxiedResponse,
} from "./web-fetch-transport.js";
export type {
  ProxyRequest,
  ProxyResponse,
  ProxiedResponse,
  RequestHeaders,
  SecureProxySocket,
  WebFetchRequester,
  WebFetchTransport,
} from "./web-fetch-transport.js";

const USER_AGENT = "RovinosAIHarness/1.0 (+https://github.com/Rovinos-AI/rovinos-ai-harness)";
const DEFAULT_ACCEPT = "text/html, text/plain, text/markdown, application/json";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RunnerFetchOptionsSchema = z
  .object({
    proxyUrl: z.url(),
    allow: SandboxEgressAllowlistSchema,
  })
  .strict();
const RunnerFetchRequestSchema = z.object({ runId: Id, request: WebFetchRequestSchema }).strict();

type EgressAllowlist = z.infer<typeof SandboxEgressAllowlistSchema>;

/** Adapts a Node response stream to the bounded fetch response interface. */
export function adaptResponse(response: NativeIncomingMessage): ProxyResponse {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    onData: (listener) => {
      response.on("data", listener);
    },
    onEnd: (listener) => {
      response.once("end", listener);
    },
    onError: (listener) => {
      response.once("error", listener);
    },
    onAborted: (listener) => {
      response.once("aborted", listener);
    },
    destroy: () => {
      response.destroy();
    },
  };
}

/** Adapts a Node client request to the proxy request interface. */
export function adaptRequest(request: NativeClientRequest): ProxyRequest {
  return {
    onError: (listener) => {
      request.once("error", listener);
    },
    onConnect: (listener) => {
      request.once("connect", (response, socket) => {
        listener(adaptResponse(response), socket);
      });
    },
    end: () => {
      request.end();
    },
  };
}

const nodeTransport: WebFetchTransport = {
  requestHttp: (options, onResponse) =>
    adaptRequest(
      createHttpRequest(options, (response) => {
        onResponse?.(adaptResponse(response));
      }),
    ),
  connectTls: (socket, servername) => {
    const secureSocket = connectTls({
      socket,
      ...(servername === undefined ? {} : { servername }),
      ALPNProtocols: ["http/1.1"],
    });
    return {
      socket: secureSocket,
      onError: (listener) => {
        secureSocket.once("error", listener);
      },
      onSecureConnect: (listener) => {
        secureSocket.once("secureConnect", listener);
      },
    };
  },
  requestHttps: (options, socket, onResponse) => {
    const agent = new HttpsAgent({ keepAlive: false });
    agent.createConnection = () => socket;
    const request = createHttpsRequest({ ...options, agent }, (response) => {
      onResponse(adaptResponse(response));
    });
    return {
      request: adaptRequest(request),
      close: () => {
        agent.destroy();
      },
    };
  },
};

/** Closed runner fetch error codes; response details are deliberately omitted. */
export class WebFetchError extends HarnessError {
  readonly code:
    | "sandbox_fetch_invalid"
    | "sandbox_fetch_denied"
    | "sandbox_fetch_egress_disabled"
    | "sandbox_fetch_redirect_limit"
    | "sandbox_fetch_failed";

  constructor(
    code:
      | "sandbox_fetch_invalid"
      | "sandbox_fetch_denied"
      | "sandbox_fetch_egress_disabled"
      | "sandbox_fetch_redirect_limit"
      | "sandbox_fetch_failed",
  ) {
    super(code);
    this.code = code;
  }
}

function hostname(url: URL): string {
  return url.hostname.toLowerCase().replaceAll(/^\[|\]$/gu, "");
}

function port(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function isLocalTestHost(value: string): boolean {
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".test");
}

function isAllowed(url: URL, allow: EgressAllowlist): boolean {
  if (url.username !== "" || url.password !== "" || !["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  if (url.protocol === "http:" && !isLocalTestHost(hostname(url))) {
    return false;
  }
  return allow.some(
    (entry) =>
      entry.host.toLowerCase().replaceAll(/^\[|\]$/gu, "") === hostname(url) &&
      entry.ports.includes(port(url)),
  );
}

function contentType(headers: IncomingHttpHeaders): string {
  const value: unknown = headers["content-type"];
  const raw = typeof value === "string" ? value : firstHeaderValue(value);
  return raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
}

function firstHeaderValue(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first: unknown = value[0];
  return typeof first === "string" ? first : undefined;
}

function headerValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : firstHeaderValue(value);
}

function resultUrl(url: URL, stripQuery: boolean): string {
  const visibleUrl = new URL(url);
  visibleUrl.hash = "";
  if (stripQuery) {
    visibleUrl.search = "";
  }
  return visibleUrl.href;
}

function safeTextEnd(text: string, end: number): number {
  return end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
    ? end - 1
    : end;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedTextResult(
  base: {
    readonly url: string;
    readonly status: number;
    readonly contentType: string;
    readonly truncated: boolean;
    readonly untrusted: true;
  },
  text: string,
  hiddenTextDropped: number,
): WebFetchResult {
  const result = { ...base, text, hiddenTextDropped };
  if (serializedBytes(result) <= MAX_WEB_FETCH_BYTES) {
    return WebFetchResultSchema.parse(result);
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    let end = safeTextEnd(text, Math.ceil((low + high) / 2));
    if (end <= low) {
      end = low + (text.charCodeAt(low) >= 0xd800 && text.charCodeAt(low) <= 0xdbff ? 2 : 1);
      if (end > high) {
        break;
      }
    }
    const candidate = { ...base, text: text.slice(0, end), hiddenTextDropped, truncated: true };
    if (serializedBytes(candidate) <= MAX_WEB_FETCH_BYTES) {
      low = end;
    } else {
      high = end - 1;
    }
  }

  return WebFetchResultSchema.parse({
    ...base,
    text: text.slice(0, safeTextEnd(text, low)),
    hiddenTextDropped,
    truncated: true,
  });
}

interface RedirectResult {
  readonly response: ProxiedResponse;
  readonly destination: URL;
}

interface RedirectRequestOptions {
  readonly initialUrl: URL;
  readonly allow: EgressAllowlist;
  readonly proxyUrl: URL;
  readonly accept: string;
  readonly requester: WebFetchRequester;
  readonly signal: AbortSignal;
}

async function requestWithRedirects(options: RedirectRequestOptions): Promise<RedirectResult> {
  let destination = options.initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowed(destination, options.allow)) {
      throw new WebFetchError("sandbox_fetch_denied");
    }
    let response: ProxiedResponse;
    try {
      response = await options.requester(
        options.proxyUrl,
        destination,
        {
          accept: options.accept,
          host: destination.host,
          "user-agent": USER_AGENT,
        },
        options.signal,
      );
    } catch {
      throw new WebFetchError("sandbox_fetch_failed");
    }
    const location = headerValue(response.headers.location);
    if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return { response, destination };
    }
    if (redirects >= MAX_WEB_FETCH_REDIRECTS) {
      throw new WebFetchError("sandbox_fetch_redirect_limit");
    }
    try {
      destination = new URL(location, destination);
    } catch {
      throw new WebFetchError("sandbox_fetch_denied");
    }
  }
}

function textResult(
  response: ProxiedResponse,
  destination: URL,
  request: WebFetchRequest,
): WebFetchResult {
  const mimeType = contentType(response.headers);
  const common = {
    url: resultUrl(destination, request.stripQuery ?? true),
    status: response.status,
    contentType: mimeType,
    truncated: response.truncated,
    untrusted: true as const,
  };
  const textContentTypes = new Set([
    "text/html",
    "text/plain",
    "text/markdown",
    "application/json",
  ]);
  if (!textContentTypes.has(mimeType)) {
    return WebFetchResultSchema.parse({
      ...common,
      binary: true,
      bytes: [...response.bytes],
    });
  }
  const decoded = new TextDecoder().decode(response.bytes);
  const converted =
    mimeType === "text/html" ? htmlToText(decoded) : { text: decoded, hiddenTextDropped: 0 };
  return boundedTextResult(common, converted.text, converted.hiddenTextDropped);
}

/**
 * Fetches web content from the runner through its configured egress proxy.
 *
 * Every redirect is revalidated against the exact host/port allowlist before the proxy
 * makes the next request; the proxy independently rejects private and metadata IPs.
 */
export async function fetchWebContent(
  input: WebFetchRequest,
  options: { readonly proxyUrl: string; readonly allow: EgressAllowlist },
  signal: AbortSignal,
  dependencies: {
    readonly requester?: WebFetchRequester;
    readonly transport?: WebFetchTransport;
    readonly timeoutMs?: number;
  } = {},
): Promise<WebFetchResult> {
  const parsedInput = WebFetchRequestSchema.safeParse(input);
  const parsedOptions = RunnerFetchOptionsSchema.safeParse(options);
  if (!parsedInput.success || !parsedOptions.success) {
    throw new WebFetchError("sandbox_fetch_invalid");
  }

  const { data: request } = parsedInput;
  const { data: fetchOptions } = parsedOptions;
  const destination = new URL(request.url);
  const deadline = AbortSignal.timeout(dependencies.timeoutMs ?? 20_000);
  const combinedSignal = AbortSignal.any([signal, deadline]);
  const transport = dependencies.transport ?? nodeTransport;
  const requester =
    dependencies.requester ??
    ((proxyUrl, redirectedUrl, headers, requestSignal) =>
      requestThroughProxy({
        transport,
        proxyUrl,
        destination: redirectedUrl,
        headers,
        signal: requestSignal,
      }));
  const result = await requestWithRedirects({
    initialUrl: destination,
    allow: fetchOptions.allow,
    proxyUrl: new URL(fetchOptions.proxyUrl),
    accept: request.accept ?? DEFAULT_ACCEPT,
    requester,
    signal: combinedSignal,
  });
  return textResult(result.response, result.destination, request);
}

/** Validates and serves one authenticated runner `/fetch` body. */
export async function executeRunnerFetch(
  body: string,
  options: {
    readonly proxyUrl?: string;
    readonly egressAllowlist?: EgressAllowlist;
    readonly fetch?: (
      request: WebFetchRequest,
      configuration: { readonly proxyUrl: string; readonly allow: EgressAllowlist },
      signal: AbortSignal,
    ) => Promise<WebFetchResult>;
  },
  signal: AbortSignal,
): Promise<WebFetchResult> {
  const parsed = parseJson(RunnerFetchRequestSchema, body, { maxBytes: 2 * 1024 * 1024 });
  if (options.proxyUrl === undefined || (options.egressAllowlist?.length ?? 0) === 0) {
    throw new WebFetchError("sandbox_fetch_egress_disabled");
  }
  return WebFetchResultSchema.parse(
    await (options.fetch ?? fetchWebContent)(
      parsed.request,
      { proxyUrl: options.proxyUrl, allow: options.egressAllowlist ?? [] },
      signal,
    ),
  );
}
