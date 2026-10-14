// SPDX-License-Identifier: Apache-2.0
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WEB_FETCH_BYTES } from "../../src/web-fetch-contracts.js";
import { fetchWebContent, WebFetchError } from "./web-fetch.js";
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
  headers: Record<string, string> = {},
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
  ) {}

  onError(listener: (error: Error) => void): void {
    if (this.failure) {
      listener(new Error("synthetic TLS failure"));
    }
  }

  onSecureConnect(listener: () => void): void {
    if (!this.failure) {
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
    readonly secureRequestFailure?: boolean;
  } = {},
): {
  readonly transport: WebFetchTransport;
  readonly requests: string[];
  readonly closed: { value: boolean };
} {
  const requests: string[] = [];
  const closed = { value: false };
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
          request.connect(reply, tunnel);
          return;
        }
        onResponse?.(reply);
        reply.complete();
      }, overrides.requestFailure === true);
    },
    connectTls: (socket, servername) => {
      requests.push(`TLS ${servername ?? "ip"}`);
      return new FakeSecureSocket(socket, overrides.tlsFailure);
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
  return { transport, requests, closed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchWebContent", () => {
  it("sends HTTP requests through the proxy and collects bounded response bodies", async () => {
    const { transport, requests } = makeTransport();
    await expect(
      fetchWebContent({ url: "http://docs.example.test:80/path" }, options, signal, { transport }),
    ).resolves.toMatchObject({ text: "proxied", status: 200 });
    expect(requests).toEqual(["GET http://docs.example.test/path"]);
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
});
