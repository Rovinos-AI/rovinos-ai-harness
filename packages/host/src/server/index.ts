// SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Code, HostConfigSchema, Id, parseJson, type HostConfig } from "@harness/schemas";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";

const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_RESOURCE_BYTES = 1_048_576;
const MAX_CALL_BYTES = 16_384;
const PERMISSION_FEATURES: Readonly<Record<string, string>> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};
const CSP_BASE = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const ResourceContentsSchema = z
  .object({
    mimeType: z.string().optional(),
    text: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const ResourceReadSchema = z
  .object({ contents: z.array(ResourceContentsSchema).min(1) })
  .passthrough();
const CspSchema = z
  .object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
    baseUriDomains: z.array(z.string()).optional(),
  })
  .passthrough();
const UiMetadataSchema = z
  .object({
    csp: CspSchema.optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const ResourceMetadataSchema = z
  .object({ ui: UiMetadataSchema.optional() })
  .passthrough();
const AppCallSchema = z
  .object({
    appId: Code,
    sessionId: Id,
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Contents returned by the connected MCP client's resources/read operation. */
export type AppResourceRead = z.infer<typeof ResourceReadSchema>;

/** An MCP Apps tool call forwarded to the host's task 3.3 handler. */
export type AppCall = z.infer<typeof AppCallSchema>;

/** Injected boundary for reading resources from their originating MCP server. */
export type AppResourceReader = (resourceUri: string) => Promise<unknown>;

/** Safe host diagnostic codes emitted for policy decisions. */
export type HostDiagnosticCode = "app_csp_request_ignored";

interface HostRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string;
  readonly url?: string;
  readonly headers: {
    readonly authorization?: string;
    readonly origin?: string;
    readonly "sec-fetch-site"?: string;
  };
}

interface HostResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(value: string): boolean;
  end(value?: string | Buffer): void;
}

interface HttpServerPort {
  once(event: "error", listener: (error: Error) => void): this;
  listen(port: number, host: string, callback: () => void): this;
  address(): { readonly port: number } | string | null;
  close(callback: (error?: Error) => void): this;
}

type RequestListener = (request: HostRequest, response: HostResponse) => void;

/** Dependencies that make process randomness, time, and app-call routing testable. */
export interface ReferenceHostDependencies {
  readonly readResource: AppResourceReader;
  readonly idGenerator?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => number;
  readonly onCode?: (code: HostDiagnosticCode) => void;
  readonly onAppCall?: (call: AppCall) => Promise<CallToolResult>;
  readonly readStatic?: (asset: "index" | "bundle") => Promise<Buffer>;
  readonly createHttpServer?: (listener: RequestListener) => HttpServerPort;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly toolResult?: CallToolResult;
}

function createHttpServer(listener: RequestListener): HttpServerPort {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const hostRequest: HostRequest = {
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.url === undefined ? {} : { url: request.url }),
      headers: {
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
        ...(request.headers["sec-fetch-site"] === undefined
          ? {}
          : { "sec-fetch-site": request.headers["sec-fetch-site"] }),
      },
      async *[Symbol.asyncIterator]() {
        yield* request;
      },
    };
    listener(hostRequest, response);
  });
}

/** Running loopback reference host and one-time channel bearer token. */
export interface ReferenceHost {
  readonly origin: string;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}

interface AppInstance {
  readonly id: string;
  readonly resourceUri: string;
  readonly sessionId: string;
}

interface ValidatedResource {
  readonly html: string;
  readonly csp: string;
  readonly permissions: readonly string[];
}

function encodeUlid(timestamp: number, randomness: Buffer): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = (BigInt(timestamp) << 80n) | BigInt(`0x${randomness.toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = `${alphabet[Number(value & 31n)]}${result}`;
    value >>= 5n;
  }
  return Id.parse(result);
}

function authorizationMatches(request: HostRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function writeJson(response: HostResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function writeError(response: HostResponse, status: number, code: string): void {
  writeJson(response, status, { error: code });
}

function isSameOrigin(request: HostRequest, origin: string): boolean {
  return (
    request.headers.origin === origin ||
    (request.headers.origin === undefined && request.headers["sec-fetch-site"] === "same-origin")
  );
}

function metadataUi(content: z.infer<typeof ResourceContentsSchema>): {
  readonly csp: z.infer<typeof CspSchema> | undefined;
  readonly permissions: Record<string, unknown>;
} {
  const metadata = ResourceMetadataSchema.safeParse(content._meta);
  if (!metadata.success || metadata.data.ui === undefined) {
    return { csp: undefined, permissions: {} };
  }
  return {
    csp: metadata.data.ui.csp,
    permissions: metadata.data.ui.permissions ?? {},
  };
}

function allowedDomains(
  requested: readonly string[] | undefined,
  allowlist: readonly string[],
  onCode: ((code: HostDiagnosticCode) => void) | undefined,
): readonly string[] {
  const allowed = new Set(allowlist.map((entry) => new URL(entry).origin));
  const filtered: string[] = [];
  for (const domain of requested ?? []) {
    let origin: string | undefined;
    try {
      origin = new URL(domain).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== undefined && allowed.has(origin)) {
      filtered.push(origin);
    } else {
      onCode?.("app_csp_request_ignored");
    }
  }
  return filtered;
}

function buildCsp(
  csp: z.infer<typeof CspSchema> | undefined,
  allowlist: readonly string[],
  onCode: ((code: HostDiagnosticCode) => void) | undefined,
): string {
  if (csp === undefined) {
    return CSP_BASE;
  }
  const connect = allowedDomains(csp.connectDomains, allowlist, onCode);
  const resources = allowedDomains(csp.resourceDomains, allowlist, onCode);
  const frames = allowedDomains(csp.frameDomains, allowlist, onCode);
  const bases = allowedDomains(csp.baseUriDomains, allowlist, onCode);
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `style-src 'unsafe-inline'${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `img-src data:${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `font-src data:${resources.length === 0 ? "" : ` ${resources.join(" ")}`}`,
    `connect-src ${connect.length === 0 ? "'none'" : connect.join(" ")}`,
    `frame-src ${frames.length === 0 ? "'none'" : frames.join(" ")}`,
    `base-uri ${bases.length === 0 ? "'none'" : bases.join(" ")}`,
    ...(resources.length === 0
      ? []
      : [`media-src data: ${resources.join(" ")}`]),
    "form-action 'none'",
  ];
  return directives.join("; ");
}

async function readValidatedResource(
  resourceUri: string,
  config: HostConfig,
  dependencies: ReferenceHostDependencies,
): Promise<ValidatedResource | undefined> {
  const result = ResourceReadSchema.safeParse(await dependencies.readResource(resourceUri));
  if (!result.success) {
    return undefined;
  }
  const content = result.data.contents[0];
  if (content?.mimeType !== RESOURCE_MIME_TYPE || content.text === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(content.text, "utf8") > MAX_RESOURCE_BYTES) {
    return undefined;
  }
  const metadata = metadataUi(content);
  const permissions = Object.keys(metadata.permissions)
    .filter(
      (permission) =>
        config.permissionAllowlist.some((allowedPermission) => allowedPermission === permission) &&
        PERMISSION_FEATURES[permission] !== undefined,
    )
    .map((permission) => PERMISSION_FEATURES[permission])
    .filter((permission) => permission !== undefined);
  return {
    html: content.text,
    csp: buildCsp(metadata.csp, config.cspAllowlist, dependencies.onCode),
    permissions,
  };
}

async function readBody(request: HostRequest, maxBytes: number): Promise<string | undefined> {
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

function htmlPage(): Promise<Buffer> {
  return readFile(fileURLToPath(new URL("../web/index.html", import.meta.url)));
}

function browserBundle(): Promise<Buffer> {
  const bundle = fileURLToPath(new URL("../web/host.js", import.meta.url));
  return readFile(bundle).catch(() =>
    readFile(fileURLToPath(new URL("../../dist/web/host.js", import.meta.url))),
  );
}

/**
 * Starts a loopback-only host for configured MCP Apps resources.
 *
 * The returned token is the only bearer credential for the protected browser channel.
 * The caller is responsible for displaying that value once to the local user.
 *
 * @param configInput - Untrusted host configuration to validate.
 * @param dependencies - MCP resource reader, app-call router, and injectable process hooks.
 * @returns Listening address and bearer token, with a close operation.
 */
export async function createReferenceHost(
  configInput: unknown,
  dependencies: ReferenceHostDependencies,
): Promise<ReferenceHost> {
  const config = HostConfigSchema.parse(configInput);
  const now = dependencies.now ?? Date.now;
  const random = dependencies.randomBytes ?? randomBytes;
  const nextId = dependencies.idGenerator ?? (() => encodeUlid(now(), random(10)));
  const token = random(32).toString("base64url");
  const apps = new Map<string, AppInstance>();
  const sessions = new Map<string, AppInstance>();
  for (const app of config.apps) {
    const instance: AppInstance = {
      id: app.id,
      resourceUri: app.resourceUri,
      sessionId: Id.parse(nextId()),
    };
    apps.set(app.resourceUri, instance);
    sessions.set(instance.sessionId, instance);
  }
  const host = config.listen.host === "localhost" ? "127.0.0.1" : config.listen.host;
  const createServerPort = dependencies.createHttpServer ?? createHttpServer;
  const readStatic = dependencies.readStatic ?? (async (asset) =>
    asset === "index" ? htmlPage() : browserBundle());
  const server = createServerPort(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      try {
        const html = await readStatic("index");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(html);
      } catch {
        writeError(response, 503, "host_page_unavailable");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/host.js") {
      try {
        const bundle = await readStatic("bundle");
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(bundle);
      } catch {
        writeError(response, 503, "host_bundle_unavailable");
      }
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      writeError(response, 404, "not_found");
      return;
    }
    const actualPort = server.address();
    const port = typeof actualPort === "object" && actualPort !== null ? actualPort.port : 0;
    const expectedOrigin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    if (!isSameOrigin(request, expectedOrigin) || !authorizationMatches(request, token)) {
      writeError(response, 403, "app_unauthorized");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const resourceUri = url.searchParams.get("resourceUri");
      if (resourceUri === null) {
        writeError(response, 404, "app_unknown");
        return;
      }
      const instance = apps.get(resourceUri);
      if (instance === undefined) {
        writeError(response, 404, "app_unknown");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      response.write(
        `event: host.ready\ndata: ${JSON.stringify({ appId: instance.id, sessionId: instance.sessionId })}\n\n`,
      );
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/app") {
      const resourceUri = url.searchParams.get("resourceUri");
      if (resourceUri === null) {
        writeError(response, 404, "app_unknown");
        return;
      }
      const instance = apps.get(resourceUri);
      if (instance === undefined) {
        writeError(response, 404, "app_unknown");
        return;
      }
      try {
        const resource = await readValidatedResource(resourceUri, config, dependencies);
        if (resource === undefined) {
          writeError(response, 422, "app_resource_invalid");
          return;
        }
        writeJson(response, 200, {
          appId: instance.id,
          sessionId: instance.sessionId,
          resourceUri,
          html: resource.html,
          csp: resource.csp,
          permissions: resource.permissions,
          toolInput: dependencies.toolInput ?? {},
          toolResult: dependencies.toolResult ?? null,
        });
      } catch {
        writeError(response, 502, "app_resource_unavailable");
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/call") {
      const body = await readBody(request, MAX_CALL_BYTES);
      if (body === undefined) {
        writeError(response, 413, "app_call_too_large");
        return;
      }
      let call: AppCall;
      try {
        call = parseJson(AppCallSchema, body, { maxBytes: MAX_CALL_BYTES });
      } catch {
        writeError(response, 400, "app_call_invalid");
        return;
      }
      const session = sessions.get(call.sessionId);
      if (session === undefined || session.id !== call.appId) {
        writeError(response, 404, "app_unknown");
        return;
      }
      if (dependencies.onAppCall === undefined) {
        writeJson(response, 200, { content: [], isError: true });
        return;
      }
      try {
        writeJson(response, 200, await dependencies.onAppCall(call));
      } catch {
        writeJson(response, 200, { content: [], isError: true });
      }
      return;
    }
    writeError(response, 404, "not_found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The reference host did not bind to a TCP address.");
  }
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  const resourceUri = config.apps[0]?.resourceUri;
  const url = new URL("/", origin);
  if (resourceUri !== undefined) {
    const app = apps.get(resourceUri);
    url.hash = new URLSearchParams({
      token,
      resourceUri,
      ...(app === undefined ? {} : { appId: app.id }),
    }).toString();
  }
  return {
    origin,
    token,
    url: url.href,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

/** The non-network policy applied to app resources before insertion into iframe srcdoc. */
export const REFERENCE_CSP = CSP_BASE;
