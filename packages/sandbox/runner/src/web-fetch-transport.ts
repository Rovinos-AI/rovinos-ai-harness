// SPDX-License-Identifier: Apache-2.0
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { MAX_WEB_FETCH_BYTES } from "../../src/web-fetch-contracts.js";

/** Fixed headers sent to an allowlisted destination. */
export interface RequestHeaders {
  readonly accept: string;
  readonly host: string;
  readonly "user-agent": string;
}

/** Minimal response events consumed from a proxied request. */
export interface ProxyResponse {
  readonly statusCode: number | undefined;
  readonly headers: IncomingHttpHeaders;
  onData(listener: (chunk: Buffer | string) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  onAborted(listener: () => void): void;
  destroy(): void;
}

/** Minimal request events consumed from the HTTP proxy. */
export interface ProxyRequest {
  onError(listener: (error: Error) => void): void;
  onConnect(listener: (response: ProxyResponse, socket: Duplex) => void): void;
  end(): void;
}

/** Minimal TLS tunnel events consumed by an HTTPS proxy request. */
export interface SecureProxySocket {
  readonly socket: Duplex;
  onError(listener: (error: Error) => void): void;
  onSecureConnect(listener: () => void): void;
}

/** Node transport surface used by the fetcher and replaced by deterministic unit-test fakes. */
export interface WebFetchTransport {
  requestHttp(
    options: {
      readonly hostname: string;
      readonly port: string;
      readonly method: "GET" | "CONNECT";
      readonly path: string;
      readonly headers: Record<string, string>;
      readonly signal: AbortSignal;
    },
    onResponse?: (response: ProxyResponse) => void,
  ): ProxyRequest;
  connectTls(socket: Duplex, servername?: string): SecureProxySocket;
  requestHttps(
    options: {
      readonly hostname: string;
      readonly port: string;
      readonly path: string;
      readonly headers: Record<string, string>;
      readonly signal: AbortSignal;
    },
    socket: Duplex,
    onResponse: (response: ProxyResponse) => void,
  ): { readonly request: ProxyRequest; close(): void };
}

/** Node response fields and events needed by the fetch transport adapter. */
export interface NativeIncomingMessage {
  readonly statusCode?: number | undefined;
  readonly headers: IncomingHttpHeaders;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  once(event: "end" | "aborted", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  destroy(): void;
}

/** Node request fields and events needed by the fetch transport adapter. */
export interface NativeClientRequest {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "connect", listener: (response: NativeIncomingMessage, socket: Duplex) => void): void;
  end(): void;
}

/** Response from one proxy exchange; bodies are already bounded to the fetch cap. */
export interface ProxiedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

/** Injectable proxy request for deterministic runner tests. */
export type WebFetchRequester = (
  proxyUrl: URL,
  destination: URL,
  headers: RequestHeaders,
  signal: AbortSignal,
) => Promise<ProxiedResponse>;

function responseBody(response: ProxyResponse): Promise<{
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (value: { readonly bytes: Uint8Array; readonly truncated: boolean }): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    response.onData((chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_WEB_FETCH_BYTES - bytes;
      if (data.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(data.subarray(0, remaining));
          bytes += remaining;
        }
        finish({ bytes: Buffer.concat(chunks, bytes), truncated: true });
        response.destroy();
        return;
      }
      chunks.push(data);
      bytes += data.byteLength;
    });
    response.onEnd(() => {
      finish({ bytes: Buffer.concat(chunks, bytes), truncated: false });
    });
    response.onError((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    response.onAborted(() => {
      if (!settled) {
        settled = true;
        reject(new Error("response aborted"));
      }
    });
  });
}

function collectResponse(response: ProxyResponse): Promise<ProxiedResponse> {
  return responseBody(response).then(({ bytes, truncated }) => ({
    status: response.statusCode ?? 502,
    headers: response.headers,
    bytes,
    truncated,
  }));
}

function proxyHeaders(headers: RequestHeaders): Record<string, string> {
  return {
    accept: headers.accept,
    host: headers.host,
    "user-agent": headers["user-agent"],
  };
}

interface ProxyRequestOptions {
  readonly transport: WebFetchTransport;
  readonly proxyUrl: URL;
  readonly destination: URL;
  readonly headers: RequestHeaders;
  readonly signal: AbortSignal;
}

function destinationPort(url: URL): number {
  return url.port === "" ? 443 : Number(url.port);
}

function proxyHttpRequest(options: ProxyRequestOptions): Promise<ProxiedResponse> {
  const { transport, proxyUrl, destination, headers, signal } = options;
  return new Promise((resolve, reject) => {
    const request = transport.requestHttp(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port === "" ? "80" : proxyUrl.port,
        method: "GET",
        path: destination.href,
        headers: proxyHeaders(headers),
        signal,
      },
      (response) => {
        void collectResponse(response).then(resolve, reject);
      },
    );
    request.onError(reject);
    request.end();
  });
}

type HttpsRequestOutcome = { readonly error: Error } | { readonly response: ProxiedResponse };

class HttpsProxyRequest {
  readonly #options: ProxyRequestOptions;
  readonly #resolve: (response: ProxiedResponse) => void;
  readonly #reject: (error: Error) => void;
  readonly #signal: AbortSignal;
  readonly #onAbort = (): void => {
    this.#finish({ error: new Error("request aborted") });
  };
  #settled = false;
  #tunnelSocket: Duplex | undefined;
  #secureSocket: SecureProxySocket | undefined;
  #closeSecureRequest: (() => void) | undefined;

  constructor(
    options: ProxyRequestOptions,
    resolve: (response: ProxiedResponse) => void,
    reject: (error: Error) => void,
  ) {
    this.#options = options;
    this.#resolve = resolve;
    this.#reject = reject;
    this.#signal = options.signal;
  }

  start(): void {
    if (this.#signal.aborted) {
      this.#onAbort();
      return;
    }
    this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    this.#startTunnel();
  }

  #finish(outcome: HttpsRequestOutcome): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#secureSocket?.socket.destroy();
    this.#tunnelSocket?.destroy();
    this.#closeSecureRequest?.();
    if ("error" in outcome) {
      this.#reject(outcome.error);
    } else {
      this.#resolve(outcome.response);
    }
  }

  #startRequest(secureSocket: SecureProxySocket): void {
    const { transport, destination, headers, signal } = this.#options;
    try {
      const secureRequest = transport.requestHttps(
        {
          hostname: destination.hostname,
          port: String(destinationPort(destination)),
          path: `${destination.pathname}${destination.search}`,
          headers: proxyHeaders(headers),
          signal,
        },
        secureSocket.socket,
        (response) => {
          void collectResponse(response).then(
            (result) => {
              this.#finish({ response: result });
            },
            (error: unknown) => {
              this.#finish({
                error: error instanceof Error ? error : new Error("request failed"),
              });
            },
          );
        },
      );
      this.#closeSecureRequest = () => {
        secureRequest.close();
      };
      secureRequest.request.onError((error) => {
        this.#finish({ error });
      });
      secureRequest.request.end();
    } catch (error) {
      this.#finish({
        error: error instanceof Error ? error : new Error("request failed"),
      });
    }
  }

  #onTunnel(response: ProxyResponse, socket: Duplex): void {
    this.#tunnelSocket = socket;
    if (this.#settled) {
      socket.destroy();
      return;
    }
    if (response.statusCode !== 200) {
      this.#finish({ error: new Error("proxy tunnel rejected") });
      return;
    }
    try {
      const servername = this.#options.destination.hostname
        .toLowerCase()
        .replaceAll(/^\[|\]$/gu, "");
      const secureSocket = this.#options.transport.connectTls(
        socket,
        isIP(servername) === 0 ? servername : undefined,
      );
      this.#secureSocket = secureSocket;
      secureSocket.onError((error) => {
        this.#finish({ error });
      });
      secureSocket.onSecureConnect(() => {
        if (!this.#settled) {
          this.#startRequest(secureSocket);
        }
      });
    } catch (error) {
      this.#finish({
        error: error instanceof Error ? error : new Error("request failed"),
      });
    }
  }

  #startTunnel(): void {
    const { transport, proxyUrl, destination, signal } = this.#options;
    const authority = `${destination.hostname}:${String(destinationPort(destination))}`;
    try {
      const tunnel = transport.requestHttp({
        hostname: proxyUrl.hostname,
        port: proxyUrl.port === "" ? "80" : proxyUrl.port,
        method: "CONNECT",
        path: authority,
        headers: { host: authority },
        signal,
      });
      tunnel.onError((error) => {
        this.#finish({ error });
      });
      tunnel.onConnect((response, socket) => {
        this.#onTunnel(response, socket);
      });
      tunnel.end();
    } catch (error) {
      this.#finish({
        error: error instanceof Error ? error : new Error("request failed"),
      });
    }
  }
}

function proxyHttpsRequest(options: ProxyRequestOptions): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    new HttpsProxyRequest(options, resolve, reject).start();
  });
}

/** Requests a destination through the configured proxy, tunneling HTTPS with a fresh TLS socket. */
export function requestThroughProxy(options: ProxyRequestOptions): Promise<ProxiedResponse> {
  return options.destination.protocol === "http:"
    ? proxyHttpRequest(options)
    : proxyHttpsRequest(options);
}
