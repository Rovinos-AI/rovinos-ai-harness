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

function proxyHttpsRequest(options: ProxyRequestOptions): Promise<ProxiedResponse> {
  const { transport, proxyUrl, destination, headers, signal } = options;
  return new Promise((resolve, reject) => {
    const authority = `${destination.hostname}:${String(destinationPort(destination))}`;
    const tunnel = transport.requestHttp({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port === "" ? "80" : proxyUrl.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
      signal,
    });
    tunnel.onError(reject);
    tunnel.onConnect((response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error("proxy tunnel rejected"));
        return;
      }
      const servername = destination.hostname.toLowerCase().replaceAll(/^\[|\]$/gu, "");
      const secureSocket = transport.connectTls(
        socket,
        isIP(servername) === 0 ? servername : undefined,
      );
      secureSocket.onError(reject);
      secureSocket.onSecureConnect(() => {
        const secureRequest = transport.requestHttps(
          {
            hostname: destination.hostname,
            port: String(destinationPort(destination)),
            path: `${destination.pathname}${destination.search}`,
            headers: proxyHeaders(headers),
            signal,
          },
          secureSocket.socket,
          (responseMessage) => {
            void collectResponse(responseMessage).then(
              (result) => {
                secureRequest.close();
                resolve(result);
              },
              (error: unknown) => {
                secureRequest.close();
                reject(error instanceof Error ? error : new Error("request failed"));
              },
            );
          },
        );
        secureRequest.request.onError((error) => {
          secureRequest.close();
          reject(error);
        });
        secureRequest.request.end();
      });
    });
    tunnel.end();
  });
}

/** Requests a destination through the configured proxy, tunneling HTTPS with a fresh TLS socket. */
export function requestThroughProxy(options: ProxyRequestOptions): Promise<ProxiedResponse> {
  return options.destination.protocol === "http:"
    ? proxyHttpRequest(options)
    : proxyHttpsRequest(options);
}
