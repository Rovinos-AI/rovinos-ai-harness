// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { HarnessError, Id, parseJson, SandboxEgressAllowlistSchema } from "@harness/schemas";
import { z } from "zod";
import { executeSpec, SANDBOX_EXEC_UID } from "./exec.js";
import {
  activateRunWorkspace,
  clearRunScratch,
  lockRunWorkspace,
} from "../../src/workspace.js";
import { MAX_EXEC_TIMEOUT_MS } from "../../src/types.js";
import type { Clock, ExecResult, ExecSpec } from "../../src/types.js";
import type { WebFetchRequest, WebFetchResult } from "../../src/web-fetch-contracts.js";
import {
  executeRunnerPayload,
  readRunnerPayload,
  type RunnerRequest,
  type RunnerResponse,
} from "./request-handler.js";

const REQUEST_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS + 10_000;
const TOKEN_HASH_BYTES = 32;
const MIN_RUNNER_TOKEN_BYTES = 32;
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

const RunnerHealthSchema = z.object({ status: z.literal("ok") }).strict();

/** Options for the authenticated runner HTTP server. */
export interface RunnerServerOptions {
  /** Authentication credential shared only by the harness and runner. */
  readonly token: string;
  /** Exact authorities accepted in HTTP Host and Origin headers. */
  readonly allowedHosts: readonly string[];
  /** Workspace root mounted into the runner container. */
  readonly workspaceRoot: string;
  /** Scratch root cleared between leases; defaults to no-op in isolated handler tests. */
  readonly temporaryRoot?: string;
  /** Clock used for lease expiry tests and operation timing. */
  readonly clock?: Clock;
  /** Trusted HTTP proxy URL injected into every child command when egress is enabled. */
  readonly proxyUrl?: string;
  /** Exact destinations permitted for runner-side web fetches. */
  readonly egressAllowlist?: RunnerEgressAllowlist;
  /** UID used for sandbox commands. */
  readonly executionUid?: number;
  /** GID used for sandbox commands. */
  readonly executionGid?: number;
  /** Executes validated requests; injectable for isolated server tests. */
  readonly execute?: (
    runId: z.infer<typeof Id>,
    spec: ExecSpec,
    signal: AbortSignal,
  ) => Promise<ExecResult>;
  /** Fetches validated content; injectable for isolated server tests. */
  readonly fetch?: (
    request: WebFetchRequest,
    options: { readonly proxyUrl: string; readonly allow: RunnerEgressAllowlist },
    signal: AbortSignal,
  ) => Promise<WebFetchResult>;
}

/** Closed runner startup error codes. */
export type RunnerConfigurationErrorCode =
  "sandbox_runner_config_invalid" | "proxy_url_without_allowlist" | "allowlist_without_proxy_url";

/** Error raised when the runner server configuration is invalid. */
export class RunnerConfigurationError extends HarnessError {
  readonly code: RunnerConfigurationErrorCode;

  constructor(code: RunnerConfigurationErrorCode = "sandbox_runner_config_invalid") {
    super(code);
    this.code = code;
  }
}

/**
 * Formats runner startup errors as only their bounded error code.
 *
 * @param error - Typed runner startup error.
 * @returns The closed error code followed by a newline.
 */
export function formatRunnerConfigurationError(error: RunnerConfigurationError): string {
  return `${error.code}\n`;
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

function writeError(response: RunnerResponse, status: number, code: string): void {
  sendJson(response, status, { code });
}

function validateRunnerOptions(options: RunnerServerOptions): ReadonlySet<string> {
  const executionUid = options.executionUid ?? SANDBOX_EXEC_UID;
  if (
    Buffer.byteLength(options.token, "utf8") < MIN_RUNNER_TOKEN_BYTES ||
    options.allowedHosts.length === 0 ||
    options.allowedHosts.some((host) => authorityFrom(host) !== host.toLowerCase()) ||
    (options.proxyUrl !== undefined && !validProxyUrl(options.proxyUrl)) ||
    !validEgressOptions(options) ||
    executionUid === process.getuid?.()
  ) {
    throw new RunnerConfigurationError();
  }
  return new Set(options.allowedHosts.map((host) => host.toLowerCase()));
}

function validEgressOptions(options: RunnerServerOptions): boolean {
  const allowlist = SandboxEgressAllowlistSchema.safeParse(options.egressAllowlist ?? []);
  return allowlist.success && (allowlist.data.length === 0 || options.proxyUrl !== undefined);
}

function validProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

type RunnerEgressAllowlist = z.infer<typeof SandboxEgressAllowlistSchema>;

interface RunnerEgressConfiguration {
  readonly allow: RunnerEgressAllowlist;
  readonly proxyUrl?: string;
}

function readRunnerEgressConfiguration(): RunnerEgressConfiguration {
  const allowText = process.env.SANDBOX_EGRESS_ALLOW;
  const allow = allowText === undefined ? [] : parseJson(SandboxEgressAllowlistSchema, allowText);
  const proxyUrl = process.env.SANDBOX_EGRESS_PROXY_URL;
  if (allow.length === 0 && proxyUrl !== undefined) {
    throw new RunnerConfigurationError("proxy_url_without_allowlist");
  }
  if (allow.length > 0 && proxyUrl === undefined) {
    throw new RunnerConfigurationError("allowlist_without_proxy_url");
  }
  return { allow, ...(proxyUrl === undefined ? {} : { proxyUrl }) };
}

/**
 * Adds trusted proxy variables and removes caller-controlled bypasses.
 *
 * @param spec - Validated execution request.
 * @param proxyUrl - Trusted proxy URL, if egress is enabled.
 * @returns The execution request with enforced proxy variables.
 */
export function withProxyEnvironment(spec: ExecSpec, proxyUrl: string | undefined): ExecSpec {
  if (proxyUrl === undefined) {
    return spec;
  }
  const env = { ...(spec.env ?? {}) };
  delete env.NO_PROXY;
  delete env.no_proxy;
  return {
    ...spec,
    env: {
      ...env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
    },
  };
}

/**
 * Executes a request with the proxy settings owned by the runner.
 *
 * @param options - Runner configuration and optional execution test port.
 * @param runId - Run owning the execution.
 * @param spec - Validated execution request.
 * @param signal - Cancellation signal for the execution.
 * @returns The bounded execution result.
 */
function executeRunnerSpec(
  options: RunnerServerOptions,
  runId: z.infer<typeof Id>,
  spec: ExecSpec,
  signal: AbortSignal,
): Promise<ExecResult> {
  const executionSpec = withProxyEnvironment(spec, options.proxyUrl);
  return options.execute === undefined
    ? executeSpec({
      runId,
      spec: executionSpec,
        signal,
        workspaceRoot: options.workspaceRoot,
        ...(options.executionUid === undefined ? {} : { executionUid: options.executionUid }),
        ...(options.executionGid === undefined ? {} : { executionGid: options.executionGid }),
      })
    : options.execute(runId, executionSpec, signal);
}

interface RunnerRequestContext {
  readonly options: RunnerServerOptions;
  readonly allowedHosts: ReadonlySet<string>;
  readonly tokenHash: Buffer;
  readonly isBusy: () => boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly leases: RunnerLeaseManager;
}

interface ActiveRunLease {
  readonly runId: z.infer<typeof Id>;
  readonly ttlMs: number;
  readonly expiresAt: number;
}

class RunnerLeaseManager {
  readonly #workspaceRoot: string;
  readonly #temporaryRoot: string | undefined;
  readonly #clock: Clock;
  #active: ActiveRunLease | undefined;
  #cancelExpiry: (() => void) | undefined;

  constructor(options: RunnerServerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#temporaryRoot = options.temporaryRoot;
    this.#clock = options.clock ?? systemClock;
  }

  async acquire(runId: z.infer<typeof Id>, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<boolean> {
    await this.#expireIfDue();
    if (this.#active !== undefined && this.#active.runId !== runId) {
      return false;
    }
    const isRenewal = this.#active?.runId === runId;
    this.#setActive(runId, ttlMs);
    try {
      if (!isRenewal) {
        await activateRunWorkspace(this.#workspaceRoot, runId);
        await clearRunScratch(this.#workspaceRoot, runId);
        await this.#clearTemporaryRoot();
      }
      return true;
    } catch (error) {
      if (!isRenewal && this.#active?.runId === runId) {
        this.#cancelExpiry?.();
        this.#cancelExpiry = undefined;
        this.#active = undefined;
        await lockRunWorkspace(this.#workspaceRoot, runId);
      }
      throw error;
    }
  }

  async release(runId: z.infer<typeof Id>): Promise<boolean> {
    await this.#expireIfDue();
    if (this.#active?.runId !== runId) {
      return false;
    }
    await this.#dropActive();
    return true;
  }

  async #dropActive(): Promise<void> {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    this.#cancelExpiry?.();
    this.#cancelExpiry = undefined;
    this.#active = undefined;
    await lockRunWorkspace(this.#workspaceRoot, active.runId);
  }

  async renew(runId: z.infer<typeof Id>): Promise<boolean> {
    return this.acquire(runId, this.#active?.runId === runId ? this.#active.ttlMs : undefined);
  }

  async #expireIfDue(): Promise<void> {
    if (this.#active !== undefined && this.#active.expiresAt <= this.#clock.now()) {
      await this.#dropActive();
    }
  }

  #setActive(runId: z.infer<typeof Id>, ttlMs: number): void {
    this.#cancelExpiry?.();
    const expiresAt = this.#clock.now() + ttlMs;
    this.#active = { runId, ttlMs, expiresAt };
    this.#cancelExpiry = this.#clock.schedule(() => {
      if (this.#active?.runId === runId && this.#active.expiresAt <= this.#clock.now()) {
        void this.release(runId);
      }
    }, ttlMs);
  }

  async #clearTemporaryRoot(): Promise<void> {
    if (this.#temporaryRoot === undefined) {
      return;
    }
    const temporaryRoot = this.#temporaryRoot;
    const entries = await readdir(temporaryRoot);
    await Promise.all(
      entries.map((entry) =>
        rm(join(temporaryRoot, entry), {
          force: true,
          recursive: true,
        }),
      ),
    );
  }
}

async function handleRunnerRequest(
  context: RunnerRequestContext,
  request: RunnerRequest,
  response: RunnerResponse,
): Promise<void> {
  const { options, allowedHosts, tokenHash } = context;
  try {
    if (!validHost(request, allowedHosts) || !validOrigin(request.headers.origin, allowedHosts)) {
      writeError(response, 400, "sandbox_host_rejected");
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, RunnerHealthSchema.parse({ status: "ok" }));
      return;
    }
    const payload = await readRunnerPayload(
      request,
      response,
      (candidate) => authorized(candidate, tokenHash),
      writeError,
    );
    if (payload === undefined) {
      return;
    }
    if (payload.kind === "lease") {
      if (await context.leases.acquire(payload.runId, payload.ttlMs)) {
        sendJson(response, 200, { status: "ok" });
      } else {
        writeError(response, 409, "sandbox_busy");
      }
      return;
    }
    if (payload.kind === "release") {
      if (context.isBusy() || !(await context.leases.release(payload.runId))) {
        writeError(response, 409, "sandbox_busy");
      } else {
        sendJson(response, 200, { status: "ok" });
      }
      return;
    }
    if (!(await context.leases.renew(payload.runId))) {
      writeError(response, 409, "sandbox_busy");
      return;
    }
    if (context.isBusy()) {
      writeError(response, 409, "sandbox_busy");
      return;
    }
    context.setBusy(true);
    const controller = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    });
    try {
      await executeRunnerPayload({
        options,
        payload,
        response,
        signal: controller.signal,
        executeSpec: (runId, spec, signal) => executeRunnerSpec(options, runId, spec, signal),
        sendJson,
        sendError: writeError,
      });
    } finally {
      context.setBusy(false);
    }
  } catch {
    if (!response.headersSent) {
      writeError(response, 500, "sandbox_internal_error");
    } else {
      response.destroy();
    }
  }
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
  let activeExec = false;
  const context: RunnerRequestContext = {
    options,
    allowedHosts,
    tokenHash,
    isBusy: () => activeExec,
    setBusy: (busy) => {
      activeExec = busy;
    },
    leases: new RunnerLeaseManager(options),
  };
  return (request, response) => handleRunnerRequest(context, request, response);
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
  const token = runnerTokenFromEnvironment();
  if (token === undefined || Buffer.byteLength(token, "utf8") < MIN_RUNNER_TOKEN_BYTES) {
    throw new RunnerConfigurationError();
  }
  delete process.env.SANDBOX_RUNNER_TOKEN;
  delete process.env.SANDBOX_RUNNER_TOKEN_FILE;
  const port = Number(process.env.SANDBOX_RUNNER_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RunnerConfigurationError();
  }
  const hostsText = process.env.SANDBOX_ALLOWED_HOSTS ?? `sandbox-runner:${String(port)}`;
  const workspaceRoot = process.env.SANDBOX_WORKSPACE_ROOT ?? "/workspaces";
  const egress = readRunnerEgressConfiguration();
  delete process.env.SANDBOX_EGRESS_ALLOW;
  delete process.env.SANDBOX_EGRESS_PROXY_URL;
  const server = createRunnerServer({
    token,
    allowedHosts: hostsText.split(",").map((host) => host.trim()),
    workspaceRoot: resolve(workspaceRoot),
    temporaryRoot: "/tmp",
    ...(egress.proxyUrl === undefined ? {} : { proxyUrl: egress.proxyUrl }),
    egressAllowlist: egress.allow,
  });
  server.listen(port, "0.0.0.0");
  return server;
}

function runnerTokenFromEnvironment(): string | undefined {
  const token = process.env.SANDBOX_RUNNER_TOKEN;
  const tokenFile = process.env.SANDBOX_RUNNER_TOKEN_FILE;
  if (token !== undefined && tokenFile !== undefined) {
    throw new RunnerConfigurationError();
  }
  if (tokenFile === undefined) {
    return token;
  }
  try {
    return readFileSync(tokenFile, { encoding: "utf8" }).trimEnd();
  } catch {
    throw new RunnerConfigurationError();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    startRunnerServer();
  } catch (error) {
    if (!(error instanceof RunnerConfigurationError)) {
      throw error;
    }
    process.stderr.write(formatRunnerConfigurationError(error));
    process.exitCode = 1;
  }
}
