// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WEB_FETCH_BYTES } from "../../src/web-fetch-contracts.js";
import { adaptRequest, adaptResponse, fetchWebContent, WebFetchError } from "./web-fetch.js";
import type {
  ProxyRequest,
  ProxyResponse,
  SecureProxySocket,
  WebFetchRequester,
  WebFetchTransport,
} from "./web-fetch.js";

const allow = [
  { host: "docs.example.test", ports: [80, 443] },
  { host: "metadata.example.test", ports: [80] },
];
const options = { proxyUrl: "http://sandbox-egress-proxy:3128", allow };
const signal = new AbortController().signal;
const requestUrl = "https://docs.example.test/page?synthetic=canary";

function response(
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: Record<string, string | string[]> = {},
) {
  return {
    status,
    headers: { "content-type": contentType, ...headers },
    bytes: typeof body === "string" ? new TextEncoder().encode(body) : body,
    truncated: false,
  };
}

class FakeResponse implements ProxyResponse {
  readonly headers: ProxyResponse["headers"];
  #dataListener: ((chunk: Buffer | string) => void) | undefined;
  #endListener: (() => void) | undefined;
  #errorListener: ((error: Error) => void) | undefined;
  #abortedListener: (() => void) | undefined;
  destroyed = false;

  constructor(
    readonly statusCode: number | undefined,
    headers: Record<string, string>,
    private readonly bytes: Uint8Array,
    private readonly completion: "end" | "aborted" | "error" = "end",
  ) {
    this.headers = headers;
  }

  onData(listener: (chunk: Buffer | string) => void): void {
    this.#dataListener = listener;
  }

  onEnd(listener: () => void): void {
    this.#endListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListener = listener;
  }

  onAborted(listener: () => void): void {
    this.#abortedListener = listener;
  }

  destroy(): void {
    this.destroyed = true;
  }

  complete(): void {
    if (this.completion === "aborted") {
      this.#abortedListener?.();
      return;
    }
    if (this.completion === "error") {
      this.#errorListener?.(new Error("synthetic transport failure"));
      return;
    }
    this.#dataListener?.(Buffer.from(this.bytes));
    this.#endListener?.();
  }
}

class FakeRequest implements ProxyRequest {
  #errorListener: ((error: Error) => void) | undefined;
  #connectListener: ((response: ProxyResponse, socket: Duplex) => void) | undefined;

  constructor(
    private readonly complete: (request: FakeRequest) => void,
    private readonly failOnEnd = false,
  ) {}

  onError(listener: (error: Error) => void): void {
    this.#errorListener = listener;
  }

  onConnect(listener: (response: ProxyResponse, socket: Duplex) => void): void {
    this.#connectListener = listener;
  }

  end(): void {
    if (this.failOnEnd) {
      this.fail(new Error("synthetic request failure"));
      return;
    }
    this.complete(this);
  }

  fail(error: Error): void {
    this.#errorListener?.(error);
  }

  connect(proxyResponse: ProxyResponse, socket: Duplex): void {
    this.#connectListener?.(proxyResponse, socket);
  }
}

class FakeSocket extends Duplex {
  override _read(): void {
    this.push(null);
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

class FakeSecureSocket implements SecureProxySocket {
  constructor(
    readonly socket: Duplex,
    private readonly failure = false,
    private readonly stalled = false,
  ) {}

  onError(listener: (error: Error) => void): void {
    if (this.failure) {
      listener(new Error("synthetic TLS failure"));
    }
  }

  onSecureConnect(listener: () => void): void {
    if (!this.failure && !this.stalled) {
      listener();
    }
  }
}

function makeTransport(
  overrides: {
    readonly body?: Uint8Array;
    readonly contentType?: string;
    readonly statusCode?: number;
    readonly location?: string;
    readonly completion?: "end" | "aborted" | "error";
    readonly connectStatus?: number;
    readonly requestFailure?: boolean;
    readonly tlsFailure?: boolean;
    readonly tlsStalled?: boolean;
    readonly secureRequestFailure?: boolean;
  } = {},
): {
  readonly transport: WebFetchTransport;
  readonly requests: string[];
  readonly closed: { value: boolean };
  readonly sockets: { readonly tunnel: FakeSocket[]; readonly tls: FakeSocket[] };
} {
  const requests: string[] = [];
  const closed = { value: false };
  const tunnelSockets: FakeSocket[] = [];
  const tlsSockets: FakeSocket[] = [];
  const sockets = { tunnel: tunnelSockets, tls: tlsSockets };
  const body = overrides.body ?? new TextEncoder().encode("proxied");
  const headers = {
    "content-type": overrides.contentType ?? "text/plain",
    ...(overrides.location === undefined ? {} : { location: overrides.location }),
  };
  const transport: WebFetchTransport = {
    requestHttp: (requestOptions, onResponse) => {
      requests.push(`${requestOptions.method} ${requestOptions.path}`);
      return new FakeRequest((request) => {
        const reply = new FakeResponse(
          overrides.connectStatus ?? overrides.statusCode ?? 200,
          headers,
          body,
          overrides.completion,
        );
        if (requestOptions.method === "CONNECT") {
          const tunnel = new FakeSocket();
          sockets.tunnel.push(tunnel);
          request.connect(reply, tunnel);
          return;
        }
        onResponse?.(reply);
        reply.complete();
      }, overrides.requestFailure === true);
    },
    connectTls: (_socket, servername) => {
      requests.push(`TLS ${servername ?? "ip"}`);
      const tlsSocket = new FakeSocket();
      sockets.tls.push(tlsSocket);
      return new FakeSecureSocket(tlsSocket, overrides.tlsFailure, overrides.tlsStalled);
    },
    requestHttps: (requestOptions, secureSocket, onResponse) => {
      requests.push(
        `HTTPS ${requestOptions.hostname}:${requestOptions.port}${requestOptions.path}`,
      );
      const reply = new FakeResponse(
        overrides.statusCode ?? 200,
        headers,
        body,
        overrides.completion,
      );
      const secureRequest = new FakeRequest((request) => {
        if (overrides.secureRequestFailure === true) {
          request.fail(new Error("synthetic secure request failure"));
          return;
        }
        onResponse(reply);
        reply.complete();
      });
      return { request: secureRequest, close: () => (closed.value = true) };
    },
  };
  return { transport, requests, closed, sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchWebContent", () => {
  it("adapts native response and request events", async () => {
    const nativeResponse = Object.assign(new PassThrough(), {
      statusCode: 201,
      headers: { "content-type": "text/plain" },
    });
    const adaptedResponse = adaptResponse(nativeResponse);
    const chunks: string[] = [];
    const ended = new Promise<void>((resolve) => {
      adaptedResponse.onEnd(resolve);
    });
    adaptedResponse.onData((chunk) => chunks.push(String(chunk)));
    adaptedResponse.onError(() => {
      throw new Error("unexpected response error");
    });
    adaptedResponse.onAborted(() => {
      throw new Error("unexpected response abort");
    });
    nativeResponse.end("adapted");
    await ended;
    expect(adaptedResponse.statusCode).toBe(201);
    expect(chunks.join("")).toBe("adapted");
    adaptedResponse.destroy();
    expect(nativeResponse.destroyed).toBe(true);

    const nativeRequest = Object.assign(new EventEmitter(), { end: vi.fn() });
    const request = adaptRequest(nativeRequest);
    let requestError: Error | undefined;
    let connectedResponse: ProxyResponse | undefined;
    let connectedSocket: Duplex | undefined;
    request.onError((error) => {
      requestError = error;
    });
    request.onConnect((connected, socket) => {
      connectedResponse = connected;
      connectedSocket = socket;
    });
    request.end();
    const connectMessage = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: {},
    });
    const socket = new PassThrough();
    nativeRequest.emit("connect", connectMessage, socket);
    nativeRequest.emit("error", new Error("synthetic native request error"));
    expect(nativeRequest.end).toHaveBeenCalledOnce();
    expect(connectedResponse?.statusCode).toBe(200);
    expect(connectedSocket).toBe(socket);
    expect(requestError).toMatchObject({ message: "synthetic native request error" });

    const failedResponse = Object.assign(new PassThrough(), {
      statusCode: undefined,
      headers: {},
    });
    const failed = adaptResponse(failedResponse);
    let failedResponseError: Error | undefined;
    let responseWasAborted = false;
    failed.onError((error) => {
      failedResponseError = error;
    });
    failed.onAborted(() => {
      responseWasAborted = true;
    });
    failedResponse.emit("error", new Error("synthetic native response error"));
    failedResponse.emit("aborted");
    expect(failedResponseError).toMatchObject({ message: "synthetic native response error" });
    expect(responseWasAborted).toBe(true);
  });

  it("sends HTTP requests through the proxy and collects bounded response bodies", async () => {
    const { transport, requests } = makeTransport();
    await expect(
      fetchWebContent({ url: "http://docs.example.test:80/path" }, options, signal, { transport }),
    ).resolves.toMatchObject({ text: "proxied", status: 200 });
    expect(requests).toEqual(["GET http://docs.example.test/path"]);
  });

  it("handles explicit ports and array-valued response headers", async () => {
    const requester: WebFetchRequester = (_proxy, destination) =>
      Promise.resolve(
        destination.pathname === "/page"
          ? response(302, "text/plain", "", { location: ["/final"] })
          : response(200, "", "array header", {
              "content-type": ["Text/Plain; charset=utf-8"],
            }),
      );
    await expect(
      fetchWebContent(
        { url: "https://docs.example.test:8443/page" },
        {
          proxyUrl: options.proxyUrl,
          allow: [{ host: "docs.example.test", ports: [8443] }],
        },
        signal,
        { requester },
      ),
    ).resolves.toMatchObject({
      url: "https://docs.example.test:8443/final",
      contentType: "text/plain",
      text: "array header",
    });

    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, {
        requester: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            bytes: new Uint8Array([1]),
            truncated: false,
          }),
      }),
    ).resolves.toMatchObject({ contentType: "application/octet-stream", binary: true });
  });

  it("truncates oversized responses and rejects aborted bodies and request errors", async () => {
    const oversized = makeTransport({ body: new Uint8Array(MAX_WEB_FETCH_BYTES + 1) });
    await expect(
      fetchWebContent({ url: "http://docs.example.test/path" }, options, signal, {
        transport: oversized.transport,
      }),
    ).resolves.toMatchObject({ truncated: true });

    const aborted = makeTransport({ completion: "aborted" });
    await expect(
      fetchWebContent({ url: "http://docs.example.test/path" }, options, signal, {
        transport: aborted.transport,
      }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });

    const failed = makeTransport({ requestFailure: true });
    await expect(
      fetchWebContent({ url: "http://docs.example.test/path" }, options, signal, {
        transport: failed.transport,
      }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });
  });

  it("creates HTTPS tunnels through the proxy before making the TLS request", async () => {
    const { transport, requests, closed } = makeTransport();
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { transport }),
    ).resolves.toMatchObject({ text: "proxied" });
    expect(requests).toEqual([
      "CONNECT docs.example.test:443",
      "TLS docs.example.test",
      "HTTPS docs.example.test:443/page?synthetic=canary",
    ]);
    expect(closed.value).toBe(true);
  });

  it("rejects failed tunnels, TLS handshakes, and secure requests", async () => {
    const tunnelFailure = makeTransport({ connectStatus: 403 });
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { transport: tunnelFailure.transport }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });

    const tlsFailure = makeTransport({ tlsFailure: true });
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { transport: tlsFailure.transport }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });

    const requestFailure = makeTransport({ secureRequestFailure: true });
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, {
        transport: requestFailure.transport,
      }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });
  });

  it("aborts stalled TLS handshakes and destroys both tunnel sockets", async () => {
    const { transport, requests, sockets } = makeTransport({ tlsStalled: true });
    const controller = new AbortController();
    const pending = fetchWebContent({ url: requestUrl }, options, controller.signal, { transport });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "sandbox_fetch_failed" });
    expect(requests).toEqual(["CONNECT docs.example.test:443", "TLS docs.example.test"]);
    expect(sockets.tunnel[0]?.destroyed).toBe(true);
    expect(sockets.tls[0]?.destroyed).toBe(true);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const idle = makeTransport({ tlsStalled: true });
    await expect(
      fetchWebContent({ url: requestUrl }, options, alreadyAborted.signal, {
        transport: idle.transport,
      }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_failed" });
    expect(idle.requests).toEqual([]);
  });

  it("converts HTML, drops hidden text, strips query strings, and returns untrusted output", async () => {
    const requester: WebFetchRequester = vi.fn(() =>
      Promise.resolve(
        response(
          200,
          "text/html; charset=utf-8",
          "<h1>visible</h1><div hidden>synthetic-canary</div><script>hidden script</script>",
        ),
      ),
    );

    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { requester }),
    ).resolves.toEqual({
      url: "https://docs.example.test/page",
      status: 200,
      contentType: "text/html",
      text: "visible",
      truncated: false,
      untrusted: true,
      hiddenTextDropped: "synthetic-canary".length,
    });
    expect(requester).toHaveBeenCalledWith(
      new URL(options.proxyUrl),
      new URL(requestUrl),
      expect.objectContaining({
        accept: "text/html, text/plain, text/markdown, application/json",
        "user-agent": "RovinosAIHarness/1.0 (+https://github.com/Rovinos-AI/rovinos-ai-harness)",
      }),
      expect.any(AbortSignal),
    );
  });

  it("returns supported plain text and preserves queries only when explicitly requested", async () => {
    const requester: WebFetchRequester = () =>
      Promise.resolve(response(200, "text/markdown", "# title"));

    await expect(
      fetchWebContent({ url: requestUrl, stripQuery: false }, options, signal, { requester }),
    ).resolves.toMatchObject({
      url: requestUrl,
      contentType: "text/markdown",
      text: "# title",
      untrusted: true,
    });
    await expect(
      fetchWebContent({ url: requestUrl, accept: "application/json" }, options, signal, {
        requester: () => Promise.resolve(response(200, "application/json", '{"ok":true}')),
      }),
    ).resolves.toMatchObject({ text: '{"ok":true}', hiddenTextDropped: 0 });
  });

  it("returns bounded binary bytes for unsupported content types", async () => {
    const requester: WebFetchRequester = () =>
      Promise.resolve(response(200, "image/png", new Uint8Array([0, 1, 255])));
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { requester }),
    ).resolves.toMatchObject({
      binary: true,
      contentType: "image/png",
      bytes: [0, 1, 255],
      untrusted: true,
    });
    expect(MAX_WEB_FETCH_BYTES).toBe(2_097_152);
  });

  it("rejects unallowlisted hosts, credentials, and non-test HTTP destinations before requesting", async () => {
    const requester: WebFetchRequester = vi.fn(() =>
      Promise.resolve(response(200, "text/plain", "ok")),
    );
    await expect(
      fetchWebContent({ url: "https://denied.example.test/page" }, options, signal, { requester }),
    ).rejects.toBeInstanceOf(WebFetchError);
    await expect(
      fetchWebContent({ url: "http://docs.example.test/page" }, options, signal, { requester }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      fetchWebContent({ url: "http://public.example.com/page" }, options, signal, { requester }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_denied" });
    await expect(
      fetchWebContent({ url: "******docs.example.test/page" }, options, signal, {
        requester,
      }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_invalid" });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("rechecks each redirect, blocks private proxy responses, and caps redirect count", async () => {
    const deniedRedirect: WebFetchRequester = () =>
      Promise.resolve(
        response(302, "text/plain", "", { location: "https://denied.example.test/private" }),
      );
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { requester: deniedRedirect }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_denied" });

    const privateRedirect: WebFetchRequester = (_proxy, destination) =>
      Promise.resolve(
        destination.hostname === "metadata.example.test"
          ? response(502, "text/plain", "private_address")
          : response(302, "text/plain", "", { location: "http://metadata.example.test/latest" }),
      );
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { requester: privateRedirect }),
    ).resolves.toMatchObject({ status: 502, text: "private_address" });

    const loop: WebFetchRequester = () =>
      Promise.resolve(response(302, "text/plain", "", { location: requestUrl }));
    await expect(
      fetchWebContent({ url: requestUrl }, options, signal, { requester: loop }),
    ).rejects.toMatchObject({ code: "sandbox_fetch_redirect_limit" });
  });

  it("truncates oversized bodies and honors the total deadline", async () => {
    const truncated: WebFetchRequester = () =>
      Promise.resolve({
        ...response(200, "text/plain", new Uint8Array(MAX_WEB_FETCH_BYTES + 1)),
        bytes: new Uint8Array(MAX_WEB_FETCH_BYTES),
        truncated: true,
      });
    const result = await fetchWebContent({ url: requestUrl }, options, signal, {
      requester: truncated,
    });
    expect(result.truncated).toBe(true);
    if (!("text" in result)) {
      throw new Error("expected text content");
    }
    expect(result.text.length).toBeGreaterThan(0);

    vi.useFakeTimers();
    const slow: WebFetchRequester = (_proxy, _destination, _headers, requestSignal) =>
      new Promise((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const pending = fetchWebContent({ url: requestUrl }, options, signal, {
      requester: slow,
      timeoutMs: 5,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).rejects.toMatchObject({ code: "sandbox_fetch_failed" });
  });

  it("keeps serialized text results within the PII JSON-size limit", async () => {
    const requester: WebFetchRequester = () =>
      Promise.resolve(response(200, "text/plain", "\u0000".repeat(MAX_WEB_FETCH_BYTES)));
    const result = await fetchWebContent({ url: requestUrl }, options, signal, { requester });
    expect(result).toMatchObject({ truncated: true, untrusted: true });
    expect("text" in result).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_WEB_FETCH_BYTES,
    );
  });
});
