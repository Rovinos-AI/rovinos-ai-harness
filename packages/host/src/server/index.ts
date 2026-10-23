// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { Code, HarnessError, HostConfigSchema, Id, type HostConfig } from "@harness/schemas";
import { countHostAppSpansAccepted } from "@harness/telemetry";
import {
  AppCallRouter,
  AppCallRouterError,
  createPolicyCheckedAppCallHandler,
} from "./app-calls.js";
import { AppRateLimiter } from "./app-limits.js";
import { AppRequestRouter } from "./app-requests.js";
import { ingestBatch, rejectBatch } from "./app-telemetry.js";
import { createRequestHandler } from "./request-handler.js";
import { readStaticAsset, writeRequestFailure } from "./http-utils.js";
import { REFERENCE_CSP } from "./resource.js";
import type {
  AppInstance,
  HttpServerPort,
  ReferenceHostDependencies,
  RequestListener,
  HostRequest,
  HostResponse,
} from "./types.js";

export { REFERENCE_CSP, AppRateLimiter };
export {
  AppContentEnvelopeSchema,
  AppRequestResultSchema,
  AppRequestRouter,
  AppRequestSchema,
  type AppContentEnvelope,
  type AppContentTokenizer,
  type AppRequest,
  type AppRequestResult,
} from "./app-requests.js";
export {
  HostContextOptionsSchema,
  createHostContext,
  type HostContextOptions,
} from "./host-context.js";
export {
  APP_TELEMETRY_TOOL,
  APP_TELEMETRY_TOOL_NAME,
  AppCallRouter,
  AppCallRouterError,
  AppTelemetryEmitArgsSchema,
  createPolicyCheckedAppCallHandler,
  type AppCallApprovalHandler,
  type AppCallExecutionContext,
  type AppCallPolicyContext,
  type AppCallRejectedReason,
} from "./app-calls.js";
export {
  AppTelemetryRejectReasonSchema,
  AppSpanBatchAckSchema,
  AppSpanBatchSchema,
  AppSpanSchema,
  ingestBatch,
  UI_DECISION_SPAN,
  UI_ERROR_SPAN,
  UI_INTERACTION_SPAN,
  UI_RENDER_SPAN,
  type AppSpan,
  type AppSpanBatch,
  type AppSpanBatchAck,
  type AppTelemetryRejectReason,
} from "./app-telemetry.js";
export { stampAppSpan, type AppSpanStampContext } from "./stamp.js";
export type { AppCall, AppResourceReader, ReferenceHostDependencies } from "./types.js";
export type { AppResourceRead, HostDiagnosticCode } from "./resource.js";
export { UiSession, UI_SESSION_SPAN, type UiSessionContext } from "./ui-session.js";

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

async function hasPendingApproval(
  dependencies: ReferenceHostDependencies,
  runId: Id,
): Promise<boolean> {
  try {
    return (await dependencies.hasPendingApproval?.(runId)) === true;
  } catch {
    return false;
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
  /** Ends all active UI-session spans when the owning run resumes. */
  endUiSessions(): void;
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
    const hostResponse: HostResponse = {
      get headersSent() {
        return response.headersSent;
      },
      onClose(onResponseClose) {
        response.once("close", onResponseClose);
        return () => {
          response.removeListener("close", onResponseClose);
        };
      },
      writeHead(status, headers) {
        response.writeHead(status, headers);
      },
      write(value) {
        return response.write(value);
      },
      end(value) {
        response.end(value);
      },
      destroy(error) {
        response.destroy(error);
      },
    };
    void listener(hostRequest, hostResponse).catch(() => {
      writeRequestFailure(hostResponse);
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

function scheduleUiSessionExpiry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
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

function createAppCallRouter(
  appConfigs: ReadonlyMap<string, HostConfig["apps"][number]>,
  dependencies: ReferenceHostDependencies,
  nextId: () => Id,
  rateLimiter: AppRateLimiter,
): AppCallRouter {
  const now = dependencies.now ?? Date.now;
  const defaultOnAppCall =
    dependencies.policy !== undefined && dependencies.tool !== undefined
      ? createPolicyCheckedAppCallHandler({
          policy: dependencies.policy,
          tool: dependencies.tool,
          nextCallId: nextId,
          ...(dependencies.onAppCallApproval === undefined
            ? {}
            : { onAppCallApproval: dependencies.onAppCallApproval }),
        })
      : undefined;
  const onAppCall = dependencies.onAppCall ?? defaultOnAppCall;
  const telemetryHandler =
    dependencies.onTelemetryEmit ??
    (async (session, payload) => {
      const parent = session.uiSession?.spanContext;
      const stamp =
        session.runId === undefined ||
        session.sessionStartTime === undefined ||
        parent === undefined
          ? undefined
          : {
              appId: Code.parse(session.id),
              runId: session.runId,
              sessionId: Id.parse(session.sessionId),
              sessionStartTime: session.sessionStartTime,
              parent,
              clock: { now },
              hasPendingApproval: await hasPendingApproval(dependencies, session.runId),
            };
      const acknowledgment = ingestBatch(payload, {
        acceptSpan: () => rateLimiter.tryAcceptSpan(session.sessionId),
        ...(stamp === undefined ? {} : { stamp }),
        onRejected: (reason) => dependencies.onAppRejected?.(reason),
      });
      countHostAppSpansAccepted(acknowledgment.accepted);
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(acknowledgment) }],
      });
    });
  const onTelemetryEmit = async (
    session: AppInstance,
    payload: unknown,
    context: Parameters<NonNullable<ReferenceHostDependencies["onTelemetryEmit"]>>[2],
  ): Promise<CallToolResult> => {
    if (!rateLimiter.tryAcquireBatch(session.sessionId)) {
      rejectBatch(payload, "rate", {
        onRejected: (reason) => dependencies.onAppRejected?.(reason),
      });
      throw new AppCallRouterError("rate_limited");
    }
    return telemetryHandler(session, payload, context);
  };
  return new AppCallRouter({
    apps: appConfigs,
    ...(onAppCall === undefined ? {} : { onAppCall }),
    onTelemetryEmit,
    ...(dependencies.onAppToolsList === undefined
      ? {}
      : { onAppToolsList: dependencies.onAppToolsList }),
    ...(dependencies.isIdOwnedByRun === undefined
      ? {}
      : { isIdOwnedByRun: dependencies.isIdOwnedByRun }),
    ...(dependencies.onAppRejected === undefined ? {} : { onRejected: dependencies.onAppRejected }),
  });
}

function createAppRequestRouter(
  appConfigs: ReadonlyMap<string, HostConfig["apps"][number]>,
  dependencies: ReferenceHostDependencies,
): AppRequestRouter {
  return new AppRequestRouter({
    apps: appConfigs,
    ...(dependencies.tokenizeAppContent === undefined
      ? {}
      : { tokenizeAppContent: dependencies.tokenizeAppContent }),
    ...(dependencies.onAppContent === undefined ? {} : { onAppContent: dependencies.onAppContent }),
    ...(dependencies.onAppRejected === undefined ? {} : { onRejected: dependencies.onAppRejected }),
  });
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
  const sessionRunId = dependencies.uiSessionContext?.runId ?? dependencies.runId;
  const rateLimiter = new AppRateLimiter(config.limits, { now });
  const appCallRouter = createAppCallRouter(registry.appConfigs, dependencies, nextId, rateLimiter);
  const appRequestRouter = createAppRequestRouter(registry.appConfigs, dependencies);
  const host = config.listen.host === "localhost" ? "127.0.0.1" : config.listen.host;
  let origin = "";
  let port = 0;
  const createServerPort = dependencies.createHttpServer ?? createHttpServer;
  const server = createServerPort(
    createRequestHandler({
      config,
      dependencies: { ...dependencies, readStatic: dependencies.readStatic ?? readStaticAsset },
      appCallRouter,
      appRequestRouter,
      rateLimiter,
      ...registry,
      nextSessionId: nextId,
      sessionRunId,
      token,
      expectedOrigin: () => origin,
      expectedHosts: () => [
        `127.0.0.1:${String(port)}`,
        `[::1]:${String(port)}`,
        `localhost:${String(port)}`,
      ],
      scheduleUiSessionExpiry: dependencies.scheduleUiSessionExpiry ?? scheduleUiSessionExpiry,
    }),
  );
  port = await startServer(server, config, host);
  origin = formatOrigin(host, port);
  const endUiSessions = (): void => {
    for (const instance of registry.sessions.values()) {
      instance.end();
    }
  };
  return {
    origin,
    token,
    url: createLaunchUrl(origin, token, config),
    endUiSessions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        endUiSessions();
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
