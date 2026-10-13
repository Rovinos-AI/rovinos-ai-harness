// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HarnessError, Id, parseJson } from "@harness/schemas";
import { z } from "zod";
import { executeSpec } from "./exec.js";
import { ExecResultSchema, ExecSpecSchema, MAX_EXEC_TIMEOUT_MS } from "../../src/types.js";
import type { ExecResult, ExecSpec } from "../../src/types.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS + 10_000;
const TOKEN_HASH_BYTES = 32;

const RunnerRequestSchema = z.object({ runId: Id, spec: ExecSpecSchema }).strict();
const RunnerHealthSchema = z.object({ status: z.literal("ok") }).strict();

interface RunnerRequest extends AsyncIterable<Buffer | string> {
  readonly headers: Pick<IncomingMessage["headers"], "authorization" | "host" | "origin">;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  resume(): this;
}

interface RunnerResponse {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(status: number, headers: Record<string, string>): this;
  end(body?: string): void;
  once(event: "close", listener: () => void): this;
  destroy(): void;
}

/** Options for the authenticated runner HTTP server. */
export interface RunnerServerOptions {
  /** Authentication credential shared only by the harness and runner. */
  readonly token: string;
  /** Exact authorities accepted in HTTP Host and Origin headers. */
  readonly allowedHosts: readonly string[];
  /** Workspace root mounted into the runner container. */
  readonly workspaceRoot: string;
  /** Executes validated requests; injectable for isolated server tests. */
  readonly execute?: (
    runId: z.infer<typeof Id>,
    spec: ExecSpec,
    signal: AbortSignal,
  ) => Promise<ExecResult>;
}

/** Error raised when the runner server is configured without required authentication. */
export class RunnerConfigurationError extends HarnessError {
  readonly code = "sandbox_runner_config_invalid";

  constructor() {
    super("The sandbox runner configuration is invalid.");
  }
}

function sendJson(response: RunnerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function authorized(request: RunnerRequest, tokenHash: Buffer): boolean {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ") !== true) {
    return false;
  }
  const candidateHash = hashToken(header.slice("Bearer ".length));
  return candidateHash.byteLength === TOKEN_HASH_BYTES && timingSafeEqual(tokenHash, candidateHash);
}

function authorityFrom(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.trim() !== value ||
    /[/@?#]/u.test(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(`http://${value}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "") {
      return undefined;
    }
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function validOrigin(origin: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      allowedHosts.has(url.host.toLowerCase())
    );
  } catch {
    return false;
  }
}

function validHost(request: RunnerRequest, allowedHosts: ReadonlySet<string>): boolean {
  const authority = authorityFrom(request.headers.host);
  return authority !== undefined && allowedHosts.has(authority);
}

async function readRequestBody(
  request: RunnerRequest,
): Promise<{ body: string } | { status: 400 | 413 }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      request.resume();
      return { status: 413 };
    }
    chunks.push(data);
  }
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { status: 400 };
  }
}

function writeError(response: RunnerResponse, status: number, code: string): void {
  sendJson(response, status, { code });
}

function validateRunnerOptions(options: RunnerServerOptions): ReadonlySet<string> {
  if (
    options.token.length === 0 ||
    options.allowedHosts.length === 0 ||
    options.allowedHosts.some((host) => authorityFrom(host) !== host.toLowerCase())
  ) {
    throw new RunnerConfigurationError();
  }
  return new Set(options.allowedHosts.map((host) => host.toLowerCase()));
}

/**
 * Creates the HTTP request handler separately so its policy can be tested without opening sockets.
 *
 * @param options - Token, allowed authorities, workspace root, and optional test executor.
 * @returns An asynchronous handler for requests to the runner API.
 */
export function createRunnerRequestHandler(
  options: RunnerServerOptions,
): (request: RunnerRequest, response: RunnerResponse) => Promise<void> {
  const allowedHosts = validateRunnerOptions(options);
  const tokenHash = hashToken(options.token);
  const runExec =
    options.execute ??
    ((_runId: z.infer<typeof Id>, spec: ExecSpec, signal: AbortSignal) =>
      executeSpec({ spec, signal, workspaceRoot: options.workspaceRoot }));
  let activeExec = false;

  return async (request, response) => {
    try {
      if (!validHost(request, allowedHosts) || !validOrigin(request.headers.origin, allowedHosts)) {
        writeError(response, 400, "sandbox_host_rejected");
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, RunnerHealthSchema.parse({ status: "ok" }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/exec") {
        writeError(response, 404, "sandbox_route_not_found");
        return;
      }
      if (!authorized(request, tokenHash)) {
        writeError(response, 401, "sandbox_unauthorized");
        return;
      }
      const body = await readRequestBody(request);
      if ("status" in body) {
        writeError(
          response,
          body.status,
          body.status === 413 ? "sandbox_request_too_large" : "sandbox_request_invalid",
        );
        return;
      }
      let parsed: z.infer<typeof RunnerRequestSchema>;
      try {
        parsed = parseJson(RunnerRequestSchema, body.body, { maxBytes: MAX_REQUEST_BYTES });
      } catch {
        writeError(response, 400, "sandbox_request_invalid");
        return;
      }
      if (activeExec) {
        writeError(response, 409, "sandbox_busy");
        return;
      }
      activeExec = true;
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) {
          controller.abort();
        }
      });
      try {
        const result = ExecResultSchema.parse(
          await runExec(parsed.runId, parsed.spec, controller.signal),
        );
        sendJson(response, 200, result);
      } catch {
        writeError(response, 500, "sandbox_exec_failed");
      } finally {
        activeExec = false;
      }
    } catch {
      if (!response.headersSent) {
        writeError(response, 500, "sandbox_internal_error");
      } else {
        response.destroy();
      }
    }
  };
}

/** Creates the internal-only runner HTTP server. */
export function createRunnerServer(options: RunnerServerOptions): Server {
  const handler = createRunnerRequestHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

/** Starts the runner server on its configured internal container port. */
export function startRunnerServer(): Server {
  const token = process.env.SANDBOX_RUNNER_TOKEN;
  const port = Number(process.env.SANDBOX_RUNNER_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RunnerConfigurationError();
  }
  const hostsText = process.env.SANDBOX_ALLOWED_HOSTS ?? `sandbox-runner:${String(port)}`;
  const workspaceRoot = process.env.SANDBOX_WORKSPACE_ROOT ?? "/workspaces";
  if (token === undefined) {
    throw new RunnerConfigurationError();
  }
  const server = createRunnerServer({
    token,
    allowedHosts: hostsText.split(",").map((host) => host.trim()),
    workspaceRoot: resolve(workspaceRoot),
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startRunnerServer();
}
