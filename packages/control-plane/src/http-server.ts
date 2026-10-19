// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  ControlPlaneConfigSchema,
  HarnessError,
  type ControlPlaneConfig,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { emitControlPlaneAudit } from "@harness/telemetry";
import {
  authenticateBearerToken,
  ControlPlaneAuthError,
  ControlPlaneRateLimiter,
  resolveControlPlaneTokens,
  toMcpAuthInfo,
  validControlPlaneHostOrigin,
  validateControlPlaneBinding,
  sha256Digest,
  type ControlPlaneAudit,
  type ControlPlaneAuditHandler,
  type ControlPlaneClock,
  type ControlPlaneSecretResolver,
} from "./auth.js";
import { controlPlaneHttpPortSchema } from "./schemas.js";
import type { ControlPlaneServerOptions } from "./server.js";

const HTTP_PATH = "/mcp";
const HTTP_TOOL = Code.parse("http_request");
const UNAUTHENTICATED_TOKEN = Code.parse("unauthenticated");

/** A running authenticated HTTP endpoint. */
export interface ControlPlaneHttpHandle {
  /** MCP endpoint URL. */
  endpoint: string;
  /** Closes the listener and active connections. */
  close(): Promise<void>;
}

interface HttpServerDependencies {
  readonly store: EventStore;
  readonly port: number;
  readonly options: ControlPlaneServerOptions;
  readonly createMcpServer: (store: EventStore, options: ControlPlaneServerOptions) => McpServer;
  readonly withSharedState: (
    store: EventStore,
    options: ControlPlaneServerOptions,
  ) => ControlPlaneServerOptions;
}

class ControlPlaneListenError extends HarnessError {
  override readonly code = "control_plane_listen_failed";

  constructor() {
    super("The control-plane HTTP listener failed.");
  }
}

/** Starts the authenticated HTTP transport for the configured MCP server. */
export async function startControlPlaneHttpTransport({
  store,
  port,
  options,
  createMcpServer,
  withSharedState,
}: HttpServerDependencies): Promise<ControlPlaneHttpHandle> {
  const controlPlane = ControlPlaneConfigSchema.parse(options.controlPlane ?? {});
  validateControlPlaneBinding(controlPlane);
  const checkedPort = controlPlaneHttpPortSchema.parse(port);
  const tokens = await resolveControlPlaneTokens(controlPlane, options.secretResolver);
  const sharedOptions = withSharedState(store, {
    ...options,
    controlPlane,
    onAudit: options.onAudit ?? emitControlPlaneAudit,
  });
  const handler = createMcpHandler(() => createMcpServer(store, sharedOptions));
  const requestHandler = toNodeHandler(handler);
  const limiter = new ControlPlaneRateLimiter(controlPlane.rateLimitPerMinute);
  const failedAuthLimiter = new ControlPlaneRateLimiter(controlPlane.rateLimitPerMinute);
  const handleRequest = createRequestListener({
    controlPlane,
    tokens,
    limiter,
    failedAuthLimiter,
    clock: options.clock,
    audit: options.onAudit ?? emitControlPlaneAudit,
    requestHandler,
  });
  const server = await createHttpServer(controlPlane, options.secretResolver, handleRequest);
  await listen(server, checkedPort, controlPlane.listen.host);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ControlPlaneListenError();
  }
  const endpointHost = controlPlane.listen.host.includes(":")
    ? `[${controlPlane.listen.host.replaceAll(/^\[|\]$/g, "")}]`
    : controlPlane.listen.host;
  const scheme = controlPlane.tls === undefined ? "http" : "https";
  return {
    endpoint: `${scheme}://${endpointHost}:${String(address.port)}${HTTP_PATH}`,
    close: () => closeServer(server),
  };
}

function createRequestListener(input: {
  readonly controlPlane: ControlPlaneConfig;
  readonly tokens: Awaited<ReturnType<typeof resolveControlPlaneTokens>>;
  readonly limiter: ControlPlaneRateLimiter;
  readonly failedAuthLimiter: ControlPlaneRateLimiter;
  readonly clock: ControlPlaneClock | undefined;
  readonly audit: ControlPlaneAuditHandler;
  readonly requestHandler: ReturnType<typeof toNodeHandler>;
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if ((request.url ?? "").split("?", 1)[0] !== HTTP_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (
      !validControlPlaneHostOrigin({
        host: request.headers.host,
        origin: request.headers.origin,
        allowedHosts: input.controlPlane.allowedHosts,
        tls: input.controlPlane.tls !== undefined,
      })
    ) {
      emitAuditSafely(input.audit, {
        tokenId: UNAUTHENTICATED_TOKEN,
        tool: HTTP_TOOL,
        outcome: Code.parse("control_plane_host_invalid"),
      });
      response.writeHead(403, { "cache-control": "no-store" }).end();
      return;
    }
    const principal = authenticateBearerToken(request.headers.authorization, input.tokens);
    if (principal === undefined) {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const failedAuthKey = Code.parse(
        `failed_auth.${sha256Digest(remoteAddress).toString("hex").slice(0, 32)}`,
      );
      const now = input.clock?.now() ?? Date.now();
      if (!input.failedAuthLimiter.tryAcquire(failedAuthKey, now)) {
        emitAuditSafely(input.audit, {
          tokenId: UNAUTHENTICATED_TOKEN,
          tool: HTTP_TOOL,
          outcome: Code.parse("control_plane_rate_limited"),
        });
        response.writeHead(429, { "cache-control": "no-store" }).end();
        return;
      }
      emitAuditSafely(input.audit, {
        tokenId: UNAUTHENTICATED_TOKEN,
        tool: HTTP_TOOL,
        outcome: Code.parse("control_plane_auth_invalid"),
      });
      response
        .writeHead(401, {
          "cache-control": "no-store",
          "www-authenticate": "Bearer",
        })
        .end();
      return;
    }
    if (!input.limiter.tryAcquire(principal.tokenId, input.clock?.now() ?? Date.now())) {
      emitAuditSafely(input.audit, {
        tokenId: principal.tokenId,
        tool: HTTP_TOOL,
        outcome: Code.parse("control_plane_rate_limited"),
      });
      response.writeHead(429, { "cache-control": "no-store" }).end();
      return;
    }

    const authenticatedRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
      auth: toMcpAuthInfo(principal),
      [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
    };
    void input.requestHandler(authenticatedRequest, response).catch(() => {
      if (!response.headersSent) {
        response
          .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end("control_plane_request_failed");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };
}

function emitAuditSafely(handler: ControlPlaneAuditHandler, audit: ControlPlaneAudit): void {
  try {
    handler(audit);
  } catch {
    return;
  }
}

async function createHttpServer(
  controlPlane: ControlPlaneConfig,
  resolver: ControlPlaneSecretResolver | undefined,
  listener: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server | HttpsServer> {
  if (controlPlane.tls === undefined) {
    return createServer(listener);
  }
  if (resolver === undefined) {
    throw new ControlPlaneAuthError("control_plane_secret_resolver_missing");
  }
  const [certificate, privateKey] = await Promise.all([
    resolver.resolve(controlPlane.tls.certFile),
    resolver.resolve(controlPlane.tls.keyFile),
  ]);
  return createHttpsServer({ cert: certificate.reveal(), key: privateKey.reveal() }, listener);
}

function listen(server: Server | HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off("error", onError);
      reject(new ControlPlaneListenError());
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server | HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(new ControlPlaneListenError());
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
