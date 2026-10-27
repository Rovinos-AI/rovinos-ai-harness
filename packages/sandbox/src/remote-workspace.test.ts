// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkspaceClient } from "./remote-workspace.js";

const runId = Id.parse("00000000000000000000000001");

function client(fetcher: typeof fetch): RemoteWorkspaceClient {
  return new RemoteWorkspaceClient({
    url: "http://runner.example",
    token: "synthetic-runner-token-that-is-at-least-32-bytes",
    timeoutGraceMs: 0,
    fetcher,
  });
}

describe("remote workspace client", () => {
  it("maps snapshot status and transport failures to stable errors", async () => {
    await expect(
      client(() => Promise.resolve(new Response(null, { status: 409 }))).createArchive(
        runId,
        1024,
        2048,
      ),
    ).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(
      client(() => Promise.resolve(new Response(null, { status: 413 }))).createArchive(
        runId,
        1024,
        2048,
      ),
    ).rejects.toMatchObject({ code: "snapshot_too_large" });
    await expect(
      client(() => Promise.reject(new Error("synthetic network failure"))).createArchive(
        runId,
        1024,
        2048,
      ),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });

  it("cancels the upload iterator when the runner stops consuming the archive", async () => {
    const returned = vi.fn();
    const iterator: AsyncIterator<Buffer> = {
      next: () => Promise.resolve({ done: false, value: Buffer.from("archive") }),
      return: () => {
        returned();
        return Promise.resolve({ done: true, value: Buffer.from("") });
      },
    };
    const archive = Object.assign(Readable.from([]), {
      [Symbol.asyncIterator]: () => iterator,
    });
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body;
      if (!(body instanceof ReadableStream)) {
        throw new TypeError("Expected a streamed archive.");
      }
      const reader = body.getReader();
      await reader.read();
      await reader.cancel();
      return new Response(null);
    };

    await expect(client(fetcher).restoreArchive(runId, Readable.from(archive), 1024, 2048))
      .resolves.toBeUndefined();
    expect(returned).toHaveBeenCalledOnce();
  });

  it("rejects bounded response bodies and malformed workspace status", async () => {
    await expect(
      client(() => Promise.resolve(new Response("x".repeat(1025)))).restoreArchive(
        runId,
        Readable.from([]),
        1024,
        2048,
      ),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    await expect(
      client(() => Promise.resolve(new Response("not-json"))).hasWorkspace(runId),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
    await expect(
      client(() => Promise.resolve(new Response(null, { status: 409 }))).hasWorkspace(runId),
    ).rejects.toMatchObject({ code: "sandbox_busy" });
  });

  it("maps an aborted restore request to a timeout code", async () => {
    vi.useFakeTimers();
    try {
      const fetcher: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => { reject(new DOMException("synthetic timeout", "AbortError")); },
            { once: true },
          );
        });
      const pending = client(fetcher).restoreArchive(runId, Readable.from([]), 1024, 2048);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await expect(pending).rejects.toMatchObject({ code: "sandbox_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
