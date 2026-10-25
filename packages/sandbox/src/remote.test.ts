// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import { MAX_WEB_FETCH_BYTES } from "./web-fetch-contracts.js";
import { RemoteSandboxBackend, RemoteSandboxError } from "./remote.js";
import type { ExecResult, ExecSpec } from "./types.js";

const runId = Id.parse("00000000000000000000000001");
const spec: ExecSpec = {
  argv: ["/bin/echo", "ok"],
  timeoutMs: 100,
  limits: { memoryMb: 128, pids: 16, outputBytes: 128, cpuSeconds: 2 },
};
const result: ExecResult = {
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  stdoutBytes: 3,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 2,
};
const fetchResult = {
  url: "https://docs.example.test/page",
  status: 200,
  contentType: "text/plain",
  text: "content",
  truncated: false,
  untrusted: true as const,
  hiddenTextDropped: 0,
};
const fetchRequest = { url: "https://docs.example.test/page?synthetic=canary" };

function requestUrl(value: RequestInfo | URL): URL {
  if (value instanceof URL) {
    return value;
  }
  return typeof value === "string" ? new URL(value) : new URL(value.url);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function backend(fetcher: typeof fetch, options: { timeoutGraceMs?: number } = {}) {
  return new RemoteSandboxBackend({
    url: "http://sandbox-runner:8080",
    token: "synthetic-runner-token-that-is-at-least-32-bytes",
    fetcher,
    ...options,
  });
}

describe("RemoteSandboxBackend", () => {
  it("checks the bounded runner health endpoint and fails closed for bad responses", async () => {
    const healthyFetcher: typeof fetch = vi.fn(() => Promise.resolve(response({ status: "ok" })));
    const remote = backend(healthyFetcher);

    await expect(remote.healthCheck()).resolves.toBe(true);
    expect(healthyFetcher).toHaveBeenCalledWith(
      new URL("http://sandbox-runner:8080/healthz"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    await expect(backend(() => Promise.resolve(response({}, 503))).healthCheck()).resolves.toBe(
      false,
    );
    await expect(
      backend(() => Promise.resolve(response({ status: "bad" }))).healthCheck(),
    ).resolves.toBe(false);
    await expect(
      backend(() => Promise.reject(new Error("synthetic network failure"))).healthCheck(),
    ).resolves.toBe(false);
  });

  it("streams workspace snapshot downloads and restores", async () => {
    let uploaded = "";
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/workspace/snapshot") {
        return new Response(Buffer.from("archive"));
      }
      if (path === "/workspace/restore") {
        const body = init?.body;
        if (!(body instanceof ReadableStream)) {
          throw new TypeError("Expected a streamed archive upload.");
        }
        const reader = body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          uploaded += Buffer.from(chunk.value).toString("utf8");
        }
        return response({ status: "ok" });
      }
      return response({ exists: true });
    });
    const remote = backend(fetcher);
    let downloaded = "";
    await pipeline(
      await remote.createArchive(runId, 1024, 2048),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.toString("utf8");
          callback();
        },
      }),
    );
    await remote.restoreArchive(runId, Readable.from([Buffer.from("archive")]), 1024, 2048);

    expect(downloaded).toBe("archive");
    expect(uploaded).toBe("archive");
    await expect(remote.hasWorkspace(runId)).resolves.toBe(true);
  });

  it("returns an empty stream when the runner has no snapshot body", async () => {
    const remote = backend(() => Promise.resolve(new Response(null)));
    let bytes = 0;

    await pipeline(
      await remote.createArchive(runId, 1024, 2048),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          callback();
        },
      }),
    );

    expect(bytes).toBe(0);
  });

  it("sends the run request with bearer authentication and validates the response", async () => {
    const fetcher: typeof fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        ["Bearer", "synthetic-runner-token-that-is-at-least-32-bytes"].join(" "),
      );
      return Promise.resolve(response(result));
    });

    await expect(backend(fetcher).exec(runId, spec, new AbortController().signal)).resolves.toEqual(
      result,
    );
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://sandbox-runner:8080/exec"),
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("maps busy and timeout status codes", async () => {
    await expect(
      backend(() => Promise.resolve(response({}, 409))).exec(
        runId,
        spec,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(
      backend(() => Promise.resolve(response({}, 504))).exec(
        runId,
        spec,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it("acquires and releases run leases using authenticated runner endpoints", async () => {
    const fetcher: typeof fetch = vi.fn(() => Promise.resolve(response({ status: "ok" })));
    const remote = backend(fetcher);

    await remote.acquireLease(runId, 30_000);
    await remote.releaseLease(runId);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("http://sandbox-runner:8080/lease"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ runId, ttlMs: 30_000 }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("http://sandbox-runner:8080/release"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ runId }),
      }),
    );
  });

  it("maps lease conflicts and rejects invalid lease durations", async () => {
    await expect(
      backend(() => Promise.resolve(response({}, 409))).acquireLease(runId),
    ).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(backend(vi.fn<typeof fetch>()).acquireLease(runId, 600_001)).rejects.toMatchObject(
      { code: "sandbox_runner_config_invalid" },
    );
  });

  it("maps other HTTP failures, invalid responses, and fetch failures to unavailable", async () => {
    const failingFetchers: (typeof fetch)[] = [
      () => Promise.resolve(response({}, 500)),
      () => Promise.resolve(new Response("not json")),
      () => Promise.reject(new Error("synthetic transport error")),
    ];
    for (const fetcher of failingFetchers) {
      await expect(
        backend(fetcher).exec(runId, spec, new AbortController().signal),
      ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    }
  });

  it("accepts JSON-escaped output up to the requested output-byte limit", async () => {
    const largeResult = {
      ...result,
      stdout: "\u0000".repeat(400_000),
      stdoutBytes: 400_000,
    };
    const largeSpec = {
      ...spec,
      limits: { ...spec.limits, outputBytes: 400_000 },
    };
    const fetcher: typeof fetch = () => Promise.resolve(response(largeResult));

    await expect(
      backend(fetcher).exec(runId, largeSpec, new AbortController().signal),
    ).resolves.toMatchObject({ stdout: largeResult.stdout, stdoutBytes: 400_000 });
  });

  it("returns an aborted result without contacting the runner when already cancelled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();

    await expect(backend(fetcher).exec(runId, spec, controller.signal)).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an aborted result when the caller cancels an in-flight request", async () => {
    const controller = new AbortController();
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
        controller.abort();
      });

    await expect(backend(fetcher).exec(runId, spec, controller.signal)).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
    });
  });

  it("maps an expired client deadline to sandbox_timeout", async () => {
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const shortSpec = { ...spec, timeoutMs: 1 };

    await expect(
      backend(fetcher, { timeoutGraceMs: 0 }).exec(runId, shortSpec, new AbortController().signal),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it("sends fetch calls to the authenticated runner endpoint and validates untrusted content", async () => {
    const fetcher: typeof fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(url).pathname).toBe("/fetch");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        ["Bearer", "synthetic-runner-token-that-is-at-least-32-bytes"].join(" "),
      );
      return Promise.resolve(response(fetchResult));
    });

    await expect(
      backend(fetcher).fetch(runId, fetchRequest, new AbortController().signal),
    ).resolves.toEqual(fetchResult);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://sandbox-runner:8080/fetch"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ runId, request: fetchRequest }),
      }),
    );
  });

  it("accepts a cap-sized fetch body with sixfold JSON escaping", async () => {
    const escapedResult = { ...fetchResult, text: "\u0000".repeat(MAX_WEB_FETCH_BYTES) };
    await expect(
      backend(() => Promise.resolve(response(escapedResult))).fetch(
        runId,
        fetchRequest,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ text: escapedResult.text });
  });

  it("maps fetch status, malformed output, abort, and transport failures safely", async () => {
    const failingFetchers: { readonly fetcher: typeof fetch; readonly code: string }[] = [
      { fetcher: () => Promise.resolve(response({}, 409)), code: "sandbox_busy" },
      { fetcher: () => Promise.resolve(response({}, 504)), code: "sandbox_timeout" },
      { fetcher: () => Promise.resolve(response({}, 500)), code: "sandbox_unavailable" },
      {
        fetcher: () => Promise.resolve(response({ url: "https://bad.example.test" })),
        code: "sandbox_unavailable",
      },
      {
        fetcher: () => Promise.reject(new Error("synthetic fetch URL")),
        code: "sandbox_unavailable",
      },
    ];
    for (const { fetcher, code } of failingFetchers) {
      await expect(
        backend(fetcher).fetch(runId, fetchRequest, new AbortController().signal),
      ).rejects.toMatchObject({ code });
    }
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      backend(vi.fn<typeof fetch>()).fetch(runId, fetchRequest, cancelled.signal),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it("maps the fetch request deadline to sandbox_timeout", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    try {
      const pending = backend(fetcher, { timeoutGraceMs: 0 }).fetch(
        runId,
        fetchRequest,
        new AbortController().signal,
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(outcome).resolves.toMatchObject({ code: "sandbox_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { url: "file:///tmp/runner", token: "synthetic-token" },
    { url: "http://user@sandbox-runner:8080", token: "synthetic-token" },
    { url: "http://sandbox-runner:8080/prefix", token: "synthetic-token" },
    { url: "http://sandbox-runner:8080", token: "" },
  ])("rejects unsafe runner configuration", ({ url, token }) => {
    expect(
      () =>
        new RemoteSandboxBackend({
          url,
          token,
          fetcher: () => Promise.resolve(response(result)),
        }),
    ).toThrow(RemoteSandboxError);
  });

  it("rejects runner tokens shorter than 32 UTF-8 bytes with a configuration error", () => {
    let configurationError: unknown;
    try {
      new RemoteSandboxBackend({
        url: "http://sandbox-runner:8080",
        token: "short-synthetic-token",
        fetcher: () => Promise.resolve(response(result)),
      });
    } catch (error) {
      configurationError = error;
    }
    expect(configurationError).toMatchObject({ code: "sandbox_runner_config_invalid" });
    expect(
      () =>
        new RemoteSandboxBackend({
          url: "http://sandbox-runner:8080",
          token: "é".repeat(16),
          fetcher: () => Promise.resolve(response(result)),
        }),
    ).not.toThrow();
  });
});
