// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function backend(fetcher: typeof fetch, options: { timeoutGraceMs?: number } = {}) {
  return new RemoteSandboxBackend({
    url: "http://sandbox-runner:8080",
    token: "synthetic-runner-token",
    fetcher,
    ...options,
  });
}

describe("RemoteSandboxBackend", () => {
  it("sends the run request with bearer authentication and validates the response", async () => {
    const fetcher: typeof fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        ["Bearer", "synthetic-runner-token"].join(" "),
      );
      return response(result);
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
      backend(async () => response({}, 409)).exec(runId, spec, new AbortController().signal),
    ).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(
      backend(async () => response({}, 504)).exec(runId, spec, new AbortController().signal),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it("maps other HTTP failures, invalid responses, and fetch failures to unavailable", async () => {
    const failingFetchers: (typeof fetch)[] = [
      async () => response({}, 500),
      async () => new Response("not json"),
      async () => {
        throw new Error("synthetic transport error");
      },
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
    const fetcher: typeof fetch = async () => response(largeResult);

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
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        controller.abort();
      });

    await expect(backend(fetcher).exec(runId, spec, controller.signal)).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
    });
  });

  it("maps an expired client deadline to sandbox_timeout", async () => {
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const shortSpec = { ...spec, timeoutMs: 1 };

    await expect(
      backend(fetcher, { timeoutGraceMs: 0 }).exec(runId, shortSpec, new AbortController().signal),
    ).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it.each([
    { url: "file:///tmp/runner", token: "synthetic-token" },
    { url: "http://user@sandbox-runner:8080", token: "synthetic-token" },
    { url: "http://sandbox-runner:8080/prefix", token: "synthetic-token" },
    { url: "http://sandbox-runner:8080", token: "" },
  ])("rejects unsafe runner configuration", ({ url, token }) => {
    expect(
      () => new RemoteSandboxBackend({ url, token, fetcher: async () => response(result) }),
    ).toThrow(RemoteSandboxError);
  });
});
