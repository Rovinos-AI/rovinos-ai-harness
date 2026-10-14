// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage } from "node:http";
import { Id, parseJson } from "@harness/schemas";
import { z } from "zod";
import { ExecResultSchema, ExecSpecSchema } from "../../src/types.js";
import type { ExecResult, ExecSpec } from "../../src/types.js";
import { WebFetchRequestSchema } from "../../src/web-fetch-contracts.js";
import { executeRunnerFetch, WebFetchError } from "./web-fetch.js";
import type { RunnerServerOptions } from "./server.js";

/** Maximum UTF-8 request body accepted by runner endpoints. */
export const MAX_RUNNER_REQUEST_BYTES = 2 * 1024 * 1024;

const RunnerExecRequestSchema = z.object({ runId: Id, spec: ExecSpecSchema }).strict();
const RunnerFetchRequestSchema = z.object({ runId: Id, request: WebFetchRequestSchema }).strict();

/** Minimal request shape used by the independently testable runner handler. */
export interface RunnerRequest extends AsyncIterable<Buffer | string> {
  readonly headers: Pick<IncomingMessage["headers"], "authorization" | "host" | "origin">;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  resume(): this;
}

/** Minimal response shape used by the independently testable runner handler. */
export interface RunnerResponse {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(status: number, headers: Record<string, string>): this;
  end(body?: string): void;
  once(event: "close", listener: () => void): this;
  destroy(): void;
}

/** Parsed, authenticated runner payload. */
export type RunnerPayload =
  | { readonly kind: "fetch"; readonly body: string }
  | { readonly kind: "exec"; readonly runId: z.infer<typeof Id>; readonly spec: ExecSpec };

type SendError = (response: RunnerResponse, status: number, code: string) => void;
type SendJson = (response: RunnerResponse, status: number, body: unknown) => void;
type IsAuthorized = (request: RunnerRequest) => boolean;
type ExecuteSpec = (
  runId: z.infer<typeof Id>,
  spec: ExecSpec,
  signal: AbortSignal,
) => Promise<ExecResult>;

interface ExecuteRunnerPayloadOptions {
  readonly options: RunnerServerOptions;
  readonly payload: RunnerPayload;
  readonly response: RunnerResponse;
  readonly signal: AbortSignal;
  readonly executeSpec: ExecuteSpec;
  readonly sendJson: SendJson;
  readonly sendError: SendError;
}

async function readRequestBody(
  request: RunnerRequest,
): Promise<{ readonly body: string } | { readonly status: 400 | 413 }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > MAX_RUNNER_REQUEST_BYTES) {
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

/** Reads and validates the authenticated endpoint payload, writing bounded errors as needed. */
export async function readRunnerPayload(
  request: RunnerRequest,
  response: RunnerResponse,
  isAuthorized: IsAuthorized,
  sendError: SendError,
): Promise<RunnerPayload | undefined> {
  if (request.method !== "POST" || (request.url !== "/exec" && request.url !== "/fetch")) {
    sendError(response, 404, "sandbox_route_not_found");
    return undefined;
  }
  if (!isAuthorized(request)) {
    sendError(response, 401, "sandbox_unauthorized");
    return undefined;
  }
  const body = await readRequestBody(request);
  if ("status" in body) {
    sendError(
      response,
      body.status,
      body.status === 413 ? "sandbox_request_too_large" : "sandbox_request_invalid",
    );
    return undefined;
  }
  try {
    if (request.url === "/fetch") {
      parseJson(RunnerFetchRequestSchema, body.body, { maxBytes: MAX_RUNNER_REQUEST_BYTES });
      return { kind: "fetch", body: body.body };
    }
    const parsed = parseJson(RunnerExecRequestSchema, body.body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return { kind: "exec", runId: parsed.runId, spec: parsed.spec };
  } catch {
    sendError(response, 400, "sandbox_request_invalid");
    return undefined;
  }
}

function fetchFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (!(error instanceof WebFetchError)) {
    return { status: 502, code: "sandbox_fetch_failed" };
  }
  const denied =
    error.code === "sandbox_fetch_denied" || error.code === "sandbox_fetch_egress_disabled";
  return { status: denied ? 403 : 502, code: error.code };
}

/** Executes a parsed runner request and maps failures to closed response codes. */
export async function executeRunnerPayload(input: ExecuteRunnerPayloadOptions): Promise<void> {
  const { options, payload, response, signal, executeSpec, sendJson, sendError } = input;
  try {
    if (payload.kind === "fetch") {
      sendJson(response, 200, await executeRunnerFetch(payload.body, options, signal));
      return;
    }
    const result = ExecResultSchema.parse(await executeSpec(payload.runId, payload.spec, signal));
    sendJson(response, 200, result);
  } catch (error: unknown) {
    const failure =
      payload.kind === "fetch" ? fetchFailure(error) : { status: 500, code: "sandbox_exec_failed" };
    sendError(response, failure.status, failure.code);
  }
}
