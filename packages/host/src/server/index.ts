// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HarnessError, HostConfigSchema, Id, type HostConfig } from "@harness/schemas";
import { createRequestHandler } from "./request-handler.js";
import { readStaticAsset, writeRequestFailure } from "./http-utils.js";
import { REFERENCE_CSP } from "./resource.js";
import type {
  AppInstance,
  HttpServerPort,
  ReferenceHostDependencies,
  RequestListener,
  HostRequest,
} from "./types.js";

export { REFERENCE_CSP };
export type { AppCall, AppResourceReader, ReferenceHostDependencies } from "./types.js";
export type { AppResourceRead, HostDiagnosticCode } from "./resource.js";

let processToken: string | undefined;

/** Closed failures that can occur while managing the reference host lifecycle. */
export type ReferenceHostErrorCode =
  "app_host_bind_failed" | "app_host_address_unavailable" | "app_host_close_failed";

/** Value-safe reference-host lifecycle error. */
export class ReferenceHostError extends HarnessError {
  readonly code: ReferenceHostErrorCode;

  /**
   * Creates a host lifecycle error without retaining platform error details.
   *
   * @param code - Closed host lifecycle error code.
   */
  constructor(code: ReferenceHostErrorCode) {
    super("The reference host lifecycle operation failed.");
    this.code = code;
  }
}

/** Running loopback reference host and one-time channel bearer token. */
export interface ReferenceHost {
  /** Same-origin base URL of the loopback server. */
  readonly origin: string;
  /** Random process-scoped token used to authorize the browser channel. */
  readonly token: string;
  /** Local launch URL with the token and first configured resource in its fragment. */
  readonly url: string;
  /** Closes the local server. */
  close(): Promise<void>;
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
        ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
        ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
        ...(request.headers["sec-fetch-site"] === undefined
          ? {}
          : { "sec-fetch-site": request.headers["sec-fetch-site"] }),
      },
      async *[Symbol.asyncIterator]() {
        for await (const chunk of request) {
          yield await Promise.resolve(chunk);
        }
      },
    };
    void listener(hostRequest, response).catch(() => {
      writeRequestFailure(response);
    });
  });
}

function encodeUlid(timestamp: number, randomness: Buffer): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = (BigInt(timestamp) << 80n) | BigInt(`0x${randomness.toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = `${alphabet.charAt(Number(value & 31n))}${result}`;
    value >>= 5n;
  }
  return Id.parse(result);
}

function createAppRegistry(config: HostConfig): {
  readonly apps: Map<string, HostConfig["apps"][number]>;
  readonly appConfigs: Map<string, HostConfig["apps"][number]>;
  readonly sessions: Map<string, AppInstance>;
} {
  const apps = new Map(config.apps.map((app) => [app.resourceUri, app]));
  const appConfigs = new Map(config.apps.map((app) => [app.id, app]));
  const sessions = new Map<string, AppInstance>();
  return { apps, appConfigs, sessions };
}

async function startServer(
  server: HttpServerPort,
  config: HostConfig,
  host: string,
): Promise<number> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, host, resolve);
    });
  } catch {
    throw new ReferenceHostError("app_host_bind_failed");
  }
  const address = server.address();
  if (address !== null && typeof address !== "string") {
    return address.port;
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  throw new ReferenceHostError("app_host_address_unavailable");
}

function formatOrigin(host: string, port: number): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${String(port)}`;
}

function createLaunchUrl(origin: string, token: string, config: HostConfig): string {
  const url = new URL("/", origin);
  const app = config.apps[0];
  if (app !== undefined) {
    url.hash = new URLSearchParams({
      token,
      resourceUri: app.resourceUri,
      appId: app.id,
    }).toString();
  }
  return url.href;
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
  processToken ??= random(32).toString("base64url");
  const token = processToken;
  const registry = createAppRegistry(config);
  const host = config.listen.host === "localhost" ? "127.0.0.1" : config.listen.host;
  let origin = "";
  let port = 0;
  const createServerPort = dependencies.createHttpServer ?? createHttpServer;
  const server = createServerPort(
    createRequestHandler({
      config,
      dependencies: { ...dependencies, readStatic: dependencies.readStatic ?? readStaticAsset },
      ...registry,
      nextSessionId: nextId,
      token,
      expectedOrigin: () => origin,
      expectedHosts: () => [
        `127.0.0.1:${String(port)}`,
        `[::1]:${String(port)}`,
        `localhost:${String(port)}`,
      ],
    }),
  );
  port = await startServer(server, config, host);
  origin = formatOrigin(host, port);
  return {
    origin,
    token,
    url: createLaunchUrl(origin, token, config),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(new ReferenceHostError("app_host_close_failed"));
          }
        });
      }),
  };
}
