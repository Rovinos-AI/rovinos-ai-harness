// SPDX-License-Identifier: Apache-2.0
import { HarnessError, SandboxRunnerUrlSchema, type Id, parseJson } from "@harness/schemas";
import { z } from "zod";
import { ExecResultSchema, MAX_EXEC_TIMEOUT_MS } from "./types.js";
import type { ExecResult, ExecSpec, SandboxBackend } from "./types.js";

const RemoteOptionsSchema = z
  .object({
    url: SandboxRunnerUrlSchema,
    token: z.string().refine((token) => new TextEncoder().encode(token).byteLength >= 32),
    timeoutGraceMs: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strict();

/** Error reported when a remote runner request fails. */
export class RemoteSandboxError extends HarnessError {
  readonly code:
    "sandbox_unavailable" | "sandbox_busy" | "sandbox_timeout" | "sandbox_runner_config_invalid";

  constructor(
    code:
      "sandbox_unavailable" | "sandbox_busy" | "sandbox_timeout" | "sandbox_runner_config_invalid",
  ) {
    super("The remote sandbox request failed.");
    this.code = code;
  }
}

/** Options for the authenticated HTTP sandbox backend. */
export interface RemoteSandboxBackendOptions {
  /** Base URL of the internal runner service. */
  readonly url: string;
  /** Resolved runner token; configuration stores this as a SecretRef. */
  readonly token: string;
  /** Extra time allowed for the runner to return after its command timeout. */
  readonly timeoutGraceMs?: number;
  /** Fetch implementation, injectable for tests. */
  readonly fetcher?: typeof fetch;
}

function wasAborted(candidate: AbortSignal): boolean {
  return candidate.aborted;
}

function abortedResult(): ExecResult {
  return {
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    durationMs: 0,
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let finished = false;
  try {
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        finished = true;
      } else {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new RemoteSandboxError("sandbox_unavailable");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Implements {@link SandboxBackend} over the token-authenticated runner API.
 *
 * @param options - Internal runner URL, resolved token, and optional fetch settings.
 */
export class RemoteSandboxBackend implements SandboxBackend {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutGraceMs: number;
  readonly #fetcher: typeof fetch;

  constructor(options: RemoteSandboxBackendOptions) {
    const parsed = RemoteOptionsSchema.safeParse({
      url: options.url,
      token: options.token,
      timeoutGraceMs: options.timeoutGraceMs,
    });
    if (!parsed.success) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    this.#url = new URL(parsed.data.url).origin;
    this.#token = parsed.data.token;
    this.#timeoutGraceMs = parsed.data.timeoutGraceMs ?? 1000;
    this.#fetcher = options.fetcher ?? fetch;
  }

  /** {@inheritDoc SandboxBackend.exec} */
  async exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult> {
    if (signal.aborted) {
      return abortedResult();
    }
    const controller = new AbortController();
    const timeoutReason = new DOMException("The sandbox request timed out.", "TimeoutError");
    const timeoutMs = Math.min(
      MAX_EXEC_TIMEOUT_MS + this.#timeoutGraceMs,
      spec.timeoutMs + this.#timeoutGraceMs,
    );
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, timeoutMs);
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.#fetcher(new URL("/exec", this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ runId, spec }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        throw new RemoteSandboxError("sandbox_busy");
      }
      if (response.status === 408 || response.status === 504) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (!response.ok) {
        throw new RemoteSandboxError("sandbox_unavailable");
      }
      const maxResponseBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        spec.limits.outputBytes * 6 + 1_048_576,
      );
      return parseJson(ExecResultSchema, await readBoundedResponse(response, maxResponseBytes), {
        maxBytes: maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      if (controller.signal.reason === timeoutReason) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (wasAborted(signal)) {
        return abortedResult();
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
