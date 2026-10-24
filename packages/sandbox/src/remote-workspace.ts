// SPDX-License-Identifier: Apache-2.0
import type { Id as IdValue } from "@rovinos/schemas";
import { parseJson } from "@rovinos/schemas";
import { Readable } from "node:stream";
import { z } from "zod";
import { RemoteSandboxError } from "./remote-errors.js";
import type { RemoteWorkspaceSnapshotPort } from "./snapshot.js";

const WorkspaceExistsResponseSchema = z.object({ exists: z.boolean() }).strict();

function responseBody(response: Response): ReadableStream<Uint8Array> {
  return (
    response.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    })
  );
}

function toWebStream(source: Readable): ReadableStream<Uint8Array> {
  const iterable: AsyncIterable<Uint8Array> = source;
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done === true) {
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of responseBody(response)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new RemoteSandboxError("sandbox_unavailable");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Authenticated streaming access to a runner-owned workspace. */
export class RemoteWorkspaceClient implements RemoteWorkspaceSnapshotPort {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutGraceMs: number;
  readonly #fetcher: typeof fetch;

  constructor(options: {
    readonly url: string;
    readonly token: string;
    readonly timeoutGraceMs: number;
    readonly fetcher: typeof fetch;
  }) {
    this.#url = options.url;
    this.#token = options.token;
    this.#timeoutGraceMs = options.timeoutGraceMs;
    this.#fetcher = options.fetcher;
  }

  async createArchive(
    runId: IdValue,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<Readable> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      10 * 60 * 1000 + this.#timeoutGraceMs,
    );
    try {
      const response = await this.#fetcher(new URL("/workspace/snapshot", this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/gzip",
        },
        body: JSON.stringify({ runId, maxFileBytes, maxSnapshotBytes }),
        signal: controller.signal,
      });
      this.#assertResponse(response);
      const body = responseBody(response);
      return Readable.from(
        (async function* () {
          try {
            for await (const chunk of body) {
              yield Buffer.from(chunk);
            }
          } finally {
            clearTimeout(timer);
          }
        })(),
      );
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    }
  }

  async restoreArchive(
    runId: IdValue,
    archive: Readable,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      10 * 60 * 1000 + this.#timeoutGraceMs,
    );
    try {
      const request: RequestInit & { readonly duplex: "half" } = {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/gzip",
          "x-run-id": runId,
          "x-max-file-bytes": String(maxFileBytes),
          "x-max-snapshot-bytes": String(maxSnapshotBytes),
          accept: "application/json",
        },
        body: toWebStream(archive),
        duplex: "half",
        signal: controller.signal,
      };
      const response = await this.#fetcher(new URL("/workspace/restore", this.#url), request);
      await readBoundedResponse(response, 1024);
      this.#assertResponse(response);
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async hasWorkspace(runId: IdValue): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 10_000);
    try {
      const response = await this.#fetcher(new URL("/workspace/exists", this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ runId }),
        signal: controller.signal,
      });
      this.#assertResponse(response);
      return parseJson(WorkspaceExistsResponseSchema, await readBoundedResponse(response, 1024), {
        maxBytes: 1024,
      }).exists;
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  #assertResponse(response: Response): void {
    if (response.status === 409) {
      throw new RemoteSandboxError("sandbox_busy");
    }
    if (response.status === 413) {
      throw new RemoteSandboxError("snapshot_too_large");
    }
    if (!response.ok) {
      throw new RemoteSandboxError("sandbox_unavailable");
    }
  }
}
