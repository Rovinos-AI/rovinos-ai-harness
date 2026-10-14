// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import process from "node:process";
import { Readable } from "node:stream";
import { Id, parseJson } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createRunnerServer,
  createRunnerRequestHandler,
  formatRunnerConfigurationError,
  RunnerConfigurationError,
  startRunnerServer,
  withProxyEnvironment,
} from "./server.js";
import type { RunnerServerOptions } from "./server.js";
import type { ExecResult, ExecSpec } from "../../src/types.js";

const token = "synthetic-runner-token-that-is-at-least-32-bytes";
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
const ResponseBodySchema = z
  .object({
    code: z.string().optional(),
    status: z.literal("ok").optional(),
    exitCode: z.number().int().nonnegative().nullable().optional(),
    signal: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

class MemoryResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  status = 0;
  body = "";
  destroyed = false;

  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  end(body?: string): void {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function makeRequest(
  options: {
    method?: string;
    url?: string;
    host?: string;
    origin?: string;
    authorization?: string;
    body?: string | Buffer;
  } = {},
) {
  const request = Readable.from(
    options.body === undefined
      ? []
      : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)],
  );
  return Object.assign(request, {
    method: options.method ?? "POST",
    url: options.url ?? "/exec",
    headers: {
      host: options.host ?? "runner.test",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    },
  });
}

function makeOptions(overrides: Partial<RunnerServerOptions> = {}): RunnerServerOptions {
  return {
    token,
    allowedHosts: ["runner.test"],
    workspaceRoot: "/tmp",
    execute: () => Promise.resolve(result),
    ...overrides,
  };
}

function makePayload(): string {
  return JSON.stringify({ runId, spec });
}

async function call(
  handler: ReturnType<typeof createRunnerRequestHandler>,
  request: ReturnType<typeof makeRequest>,
): Promise<MemoryResponse> {
  const response = new MemoryResponse();
  await handler(request, response);
  return response;
}

function responseBody(response: MemoryResponse): z.infer<typeof ResponseBodySchema> {
  return parseJson(ResponseBodySchema, response.body);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runner HTTP request handler", () => {
  it("rejects execution credentials that match the runner identity", () => {
    const serverUid = process.getuid?.() ?? 0;
    const serverGid = process.getgid?.() ?? 0;

    expect(() => createRunnerServer(makeOptions({ executionUid: serverUid }))).toThrowError(
      RunnerConfigurationError,
    );
    expect(() => createRunnerServer(makeOptions({ executionGid: serverGid }))).toThrowError(
      RunnerConfigurationError,
    );
  });

  it("serves health without auth and rejects unknown routes", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const health = await call(handler, makeRequest({ method: "GET", url: "/healthz" }));
    const missing = await call(
      handler,
      makeRequest({ url: "/missing", authorization: "Bearer " + token }),
    );

    expect(health.status).toBe(200);
    expect(responseBody(health)).toEqual({ status: "ok" });
    expect(missing.status).toBe(404);
    expect(responseBody(missing)).toMatchObject({ code: "sandbox_route_not_found" });
  });

  it("rejects missing and incorrect bearer credentials", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const missing = await call(handler, makeRequest({ body: makePayload() }));
    const incorrect = await call(
      handler,
      makeRequest({
        authorization: ["Bearer", "incorrect-synthetic-token"].join(" "),
        body: makePayload(),
      }),
    );
    const malformed = await call(
      handler,
      makeRequest({ authorization: "Basic wrong", body: makePayload() }),
    );

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(malformed.status).toBe(401);
  });

  it("rejects unexpected Host and Origin values", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const wrongHost = await call(
      handler,
      makeRequest({ host: "untrusted.test", authorization: "Bearer " + token }),
    );
    const wrongHostPort = await call(
      handler,
      makeRequest({ host: "runner.test:8080", authorization: "Bearer " + token }),
    );
    const malformedHost = await call(
      handler,
      makeRequest({ host: "http://runner.test", authorization: "Bearer " + token }),
    );
    const wrongOrigin = await call(
      handler,
      makeRequest({
        origin: "https://untrusted.test",
        authorization: "Bearer " + token,
      }),
    );
    const validOrigin = await call(
      handler,
      makeRequest({
        origin: "https://runner.test",
        authorization: "Bearer " + token,
        body: makePayload(),
      }),
    );

    expect(wrongHost.status).toBe(400);
    expect(wrongHostPort.status).toBe(400);
    expect(malformedHost.status).toBe(400);
    expect(wrongOrigin.status).toBe(400);
    expect(validOrigin.status).toBe(200);
  });

  it("validates the request schema and enforces the two MiB body limit", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const invalid = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: "{}" }),
    );
    const invalidUtf8 = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: Buffer.from([0xff]) }),
    );
    const oversized = await call(
      handler,
      makeRequest({
        authorization: "Bearer " + token,
        body: Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
      }),
    );

    expect(invalid.status).toBe(400);
    expect(invalidUtf8.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("executes an authenticated request and returns a schema-validated result", async () => {
    const execute = vi.fn(() => Promise.resolve(result));
    const handler = createRunnerRequestHandler(makeOptions({ execute }));

    const response = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );

    expect(response.status).toBe(200);
    expect(responseBody(response)).toMatchObject({ stdout: "ok\n" });
    expect(execute).toHaveBeenCalledWith(runId, spec, expect.any(AbortSignal));
  });

  it("injects both proxy spellings and removes proxy bypass variables", async () => {
    const execute = vi.fn((_runId: typeof runId, _spec: ExecSpec) => Promise.resolve(result));
    const handler = createRunnerRequestHandler(
      makeOptions({ execute, proxyUrl: "http://sandbox-egress-proxy:3128" }),
    );
    const response = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );
    const executedSpec = execute.mock.calls[0]?.[1];
    expect(response.status).toBe(200);
    expect(executedSpec?.env).toEqual({
      HTTP_PROXY: "http://sandbox-egress-proxy:3128",
      HTTPS_PROXY: "http://sandbox-egress-proxy:3128",
      http_proxy: "http://sandbox-egress-proxy:3128",
      https_proxy: "http://sandbox-egress-proxy:3128",
    });
    expect(executedSpec?.env).not.toHaveProperty("NO_PROXY");
    expect(executedSpec?.env).not.toHaveProperty("no_proxy");
    expect(() => createRunnerRequestHandler(makeOptions({ proxyUrl: "file:///tmp/proxy" }))).toThrow(
      RunnerConfigurationError,
    );
  });

  it("removes both proxy bypass spellings from a child environment", () => {
    const execution = withProxyEnvironment(
      {
        ...spec,
        env: {
          NO_PROXY: "*",
          no_proxy: "*",
          HTTP_PROXY: "http://untrusted.example.test",
          http_proxy: "http://untrusted.example.test",
          CUSTOM_VALUE: "preserved",
        },
      },
      "http://sandbox-egress-proxy:3128",
    );

    expect(execution.env).toEqual({
      CUSTOM_VALUE: "preserved",
      HTTP_PROXY: "http://sandbox-egress-proxy:3128",
      HTTPS_PROXY: "http://sandbox-egress-proxy:3128",
      http_proxy: "http://sandbox-egress-proxy:3128",
      https_proxy: "http://sandbox-egress-proxy:3128",
    });
  });

  it("rejects overlapping executions with a busy response", async () => {
    let releaseExecution: (value: ExecResult) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<ExecResult>((resolve) => {
      releaseExecution = resolve;
    });
    const handler = createRunnerRequestHandler(
      makeOptions({
        execute: async () => {
          markStarted();
          return pending;
        },
      }),
    );
    const first = call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );
    await started;
    const second = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );
    releaseExecution(result);
    await first;

    expect(second.status).toBe(409);
    expect(responseBody(second)).toMatchObject({ code: "sandbox_busy" });
  });

  it("aborts execution when the response closes before it completes", async () => {
    let releaseExecution: (value: ExecResult) => void = () => undefined;
    let markStarted: (signal: AbortSignal) => void = () => undefined;
    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<ExecResult>((resolve) => {
      releaseExecution = resolve;
    });
    const handler = createRunnerRequestHandler(
      makeOptions({
        execute: async (_runId, _spec, signal) => {
          markStarted(signal);
          return pending;
        },
      }),
    );
    const request = makeRequest({ authorization: "Bearer " + token, body: makePayload() });
    const response = new MemoryResponse();
    const execution = handler(request, response);
    const signal = await started;
    response.emit("close");
    releaseExecution(result);
    await execution;

    expect(signal.aborted).toBe(true);
  });

  it("returns a safe execution failure when the executor or result contract fails", async () => {
    const failing = createRunnerRequestHandler(
      makeOptions({ execute: () => Promise.reject(new Error("synthetic failure")) }),
    );
    const invalidResult = createRunnerRequestHandler(
      makeOptions({ execute: () => Promise.resolve({ ...result, exitCode: -1 }) }),
    );
    const request = () => makeRequest({ authorization: "Bearer " + token, body: makePayload() });

    expect((await call(failing, request())).status).toBe(500);
    expect((await call(invalidResult, request())).status).toBe(500);
  });

  it("rejects requests with a failed body stream without exposing details", async () => {
    const handler = createRunnerRequestHandler(makeOptions());
    const request = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error("synthetic stream failure"));
        },
      }),
      {
        method: "POST",
        url: "/exec",
        headers: { host: "runner.test", authorization: "Bearer " + token },
      },
    );

    const response = await call(handler, request);

    expect(response.status).toBe(500);
    expect(response.body).not.toContain("synthetic stream failure");
  });

  it("rejects empty tokens, missing hosts, and malformed allowlists", () => {
    expect(() => createRunnerRequestHandler(makeOptions({ token: "" }))).toThrow(
      RunnerConfigurationError,
    );
    expect(() =>
      createRunnerRequestHandler(makeOptions({ token: "short-synthetic-token" })),
    ).toThrow(RunnerConfigurationError);
    expect(() => createRunnerRequestHandler(makeOptions({ token: "é".repeat(16) }))).not.toThrow();
    expect(() => createRunnerRequestHandler(makeOptions({ allowedHosts: [] }))).toThrow(
      RunnerConfigurationError,
    );
    expect(() =>
      createRunnerRequestHandler(makeOptions({ allowedHosts: ["runner.test/path"] })),
    ).toThrow(RunnerConfigurationError);
  });

  it("requires a strong token at startup and removes it from the environment", () => {
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", "");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", "short-token");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", token);
    vi.stubEnv("SANDBOX_RUNNER_PORT", "0");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    expect(process.env.SANDBOX_RUNNER_TOKEN).toBeUndefined();
    vi.stubEnv("SANDBOX_RUNNER_PORT", "8080");
    delete process.env.SANDBOX_RUNNER_TOKEN;
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
  });

  it("refuses a proxy URL when the egress allowlist is empty", () => {
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", token);
    vi.stubEnv("SANDBOX_RUNNER_PORT", "8080");
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", "[]");
    vi.stubEnv("SANDBOX_EGRESS_PROXY_URL", "http://sandbox-egress-proxy:3128");

    let caught: unknown;
    try {
      startRunnerServer();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof RunnerConfigurationError)) {
      throw new Error("Expected the proxy-without-allowlist configuration error.");
    }
    expect(caught.code).toBe("proxy_url_without_allowlist");
    expect(caught.message).toBe("proxy_url_without_allowlist");
    expect(formatRunnerConfigurationError(caught)).toBe("proxy_url_without_allowlist\n");
  });
});
