// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HostResponse } from "./types.js";
import { readStaticAsset, writeRequestFailure } from "./http-utils.js";

function makeResponse(headersSent: boolean): {
  readonly response: HostResponse;
  readonly writeHead: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const writeHead = vi.fn();
  const end = vi.fn();
  const destroy = vi.fn();
  const response: HostResponse = {
    headersSent,
    writeHead,
    write: vi.fn(() => true),
    end,
    destroy,
  };
  return { response, writeHead, end, destroy };
}

describe("writeRequestFailure", () => {
  it("writes a bounded error if the response has not started", () => {
    const { response, writeHead, end, destroy } = makeResponse(false);
    writeRequestFailure(response);
    expect(writeHead).toHaveBeenCalledExactlyOnceWith(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    expect(end).toHaveBeenCalledExactlyOnceWith('{"error":"app_host_request_failed"}');
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys a response whose headers have already been sent", () => {
    const { response, writeHead, end, destroy } = makeResponse(true);
    writeRequestFailure(response);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reads the host page from source and falls back to the built bundle", async () => {
    const page = await readStaticAsset("index");
    expect(page.toString("utf8")).toContain('<script src="/host.js"');

    // The unbundled source tree has no host.js, so this always takes the dist fallback; that
    // file exists only after `yarn workspace @rovinos/host build`.
    const bundle = await readStaticAsset("bundle").then(
      (contents) => contents.byteLength > 0,
      (error: unknown) => error instanceof Error,
    );
    expect(bundle).toBe(true);
  });

  it("reads packed host assets beside the bundle entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-static-assets-"));
    try {
      const assetDirectory = join(root, "dist/assets/web");
      await mkdir(assetDirectory, { recursive: true });
      await writeFile(join(assetDirectory, "index.html"), "<html>packed host</html>");
      const moduleUrl = pathToFileURL(join(root, "dist/bin.js")).href;

      await expect(readStaticAsset("index", moduleUrl)).resolves.toEqual(
        await readFile(join(assetDirectory, "index.html")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
