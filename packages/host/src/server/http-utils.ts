// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HostRequest, HostResponse } from "./types.js";

/** Checks the constant-time bearer-token comparison for an API request. */
export function authorizationMatches(request: HostRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") !== true) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Checks a same-origin header, permitting browser fetch metadata when Origin is omitted. */
export function isSameOrigin(request: HostRequest, origin: string): boolean {
  return (
    request.headers.origin === origin ||
    (request.headers.origin === undefined && request.headers["sec-fetch-site"] === "same-origin")
  );
}

/** Writes a bounded JSON response with non-cacheable, nosniff headers. */
export function writeJson(response: HostResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // JSON is never rendered or framed, including the 503 returned when a static asset is missing.
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
}

/** Writes a code-only JSON error response. */
export function writeError(response: HostResponse, status: number, code: string): void {
  writeJson(response, status, { error: code });
}

/** Ends request handling without attempting a second response after headers were sent. */
export function writeRequestFailure(response: HostResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(500, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end('{"error":"app_host_request_failed"}');
}

/** Reads a request body only while it remains under the supplied byte limit. */
export async function readBody(
  request: HostRequest,
  maxBytes: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads the packaged host page or browser bundle from the workspace build output. */
export function readStaticAsset(asset: "index" | "bundle"): Promise<Buffer> {
  const path =
    asset === "index"
      ? new URL("../web/index.html", import.meta.url)
      : new URL("../web/host.js", import.meta.url);
  return readFile(fileURLToPath(path)).catch((error: unknown) => {
    if (asset === "index") {
      throw error;
    }
    return readFile(fileURLToPath(new URL("../../dist/web/host.js", import.meta.url)));
  });
}
