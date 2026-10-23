// SPDX-License-Identifier: Apache-2.0
import { Id, parseJson, type HostConfig } from "@harness/schemas";
import { countHostAppRejected } from "@harness/telemetry";
import {
  AppCallSchema,
  type AppCall,
  type AppInstance,
  type HostRequest,
  type HostResponse,
  type ReferenceHostDependencies,
} from "./types.js";
import { readValidatedResource } from "./resource.js";
import {
  authorizationMatches,
  isSameOrigin,
  readBody,
  readStaticAsset,
  writeError,
  writeJson,
} from "./http-utils.js";
import { UiSession } from "./ui-session.js";
import { AppCallRouterError } from "./app-calls.js";
import type { AppCallRouter } from "./app-calls.js";
import { AppRequestSchema, type AppRequestRouter } from "./app-requests.js";
import type { AppRateLimiter } from "./app-limits.js";
import { z } from "zod";

const MAX_CALL_BYTES = 32_768;
const RUNS_RESOURCE_URI = "harness://runs";
const ResourceUpdateSubscriptionSchema = z
  .object({ resourceUri: z.literal(RUNS_RESOURCE_URI), sessionId: Id })
  .strict();

interface RequestHandlerOptions {
  readonly config: HostConfig;
  readonly dependencies: ReferenceHostDependencies;
  readonly appCallRouter: AppCallRouter;
  readonly appRequestRouter: AppRequestRouter;
  readonly rateLimiter: AppRateLimiter;
  readonly apps: ReadonlyMap<string, HostConfig["apps"][number]>;
  readonly appConfigs: ReadonlyMap<string, HostConfig["apps"][number]>;
  readonly sessions: Map<string, AppInstance>;
  readonly nextSessionId: () => string;
  readonly sessionRunId: AppInstance["runId"];
  readonly scheduleUiSessionExpiry: (callback: () => void, delayMs: number) => () => void;
  readonly token: string;
  readonly expectedOrigin: () => string;
  readonly expectedHosts: () => readonly string[];
}
type StatefulRequestHandlerOptions = RequestHandlerOptions & {
  readonly resourceUpdateSubscriptions: Map<string, () => void>;
};

const HOST_PAGE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src data: http: https:; font-src data: http: https:; connect-src 'self' http: https:; media-src data: http: https:; frame-src 'self'; child-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function isAuthorizedApiRequest(request: HostRequest, options: RequestHandlerOptions): boolean {
  return (
    isSameOrigin(request, options.expectedOrigin()) && authorizationMatches(request, options.token)
  );
}

async function handleStaticRequest(
  request: HostRequest,
  response: HostResponse,
  readStatic: NonNullable<ReferenceHostDependencies["readStatic"]>,
): Promise<boolean> {
  const page = request.method === "GET" && request.url?.split("?", 1)[0] === "/";
  const bundle = request.method === "GET" && request.url?.split("?", 1)[0] === "/host.js";
  if (!page && !bundle) {
    return false;
  }
  const asset = page ? "index" : "bundle";
  try {
    const contents = await readStatic(asset);
    response.writeHead(200, {
      "content-type": page ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": HOST_PAGE_CSP,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    response.end(contents);
  } catch {
    writeError(response, 503, page ? "host_page_unavailable" : "host_bundle_unavailable");
  }
  return true;
}

function sendAppEvents(
  url: URL,
  response: HostResponse,
  options: StatefulRequestHandlerOptions,
): void {
  const resourceUri = url.searchParams.get("resourceUri");
  const app = resourceUri === null ? undefined : options.apps.get(resourceUri);
  if (app === undefined) {
    writeError(response, 404, "app_unknown");
    return;
  }
  if (options.sessions.size >= options.config.maxUiSessions) {
    writeError(response, 429, "app_session_limit");
    return;
  }
  const sessionId = Id.parse(options.nextSessionId());
  const sessionStartTime = (options.dependencies.now ?? Date.now)();
  const uiSession = app.telemetry
    ? new UiSession(options.dependencies.uiSessionContext, app.id, sessionId, () => {
        options.dependencies.onCode("ui_trace_unavailable");
      })
    : undefined;
  let cancelExpiry = (): void => undefined;
  // Explicit end, expiry, and host close all funnel through this callback.
  const end = (): void => {
    cancelExpiry();
    options.resourceUpdateSubscriptions.get(sessionId)?.();
    options.resourceUpdateSubscriptions.delete(sessionId);
    uiSession?.end();
    if (options.sessions.get(sessionId)?.end === end) {
      options.sessions.delete(sessionId);
      options.rateLimiter.endSession(sessionId);
    }
  };
  const instance: AppInstance = {
    id: app.id,
    resourceUri: app.resourceUri,
    sessionId,
    sessionStartTime,
    ...(options.sessionRunId === undefined ? {} : { runId: options.sessionRunId }),
    ...(uiSession === undefined ? {} : { uiSession }),
    end,
  };
  options.sessions.set(instance.sessionId, instance);
  try {
    cancelExpiry = options.scheduleUiSessionExpiry(() => {
      if (options.sessions.get(sessionId)?.end === end) {
        end();
        options.dependencies.onCode("ui_session_expired");
      }
    }, options.config.uiSessionMaxMs);
  } catch (error) {
    instance.end();
    throw error;
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
}

async function sendAppResource(
  url: URL,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
  const resourceUri = url.searchParams.get("resourceUri");
  const app = resourceUri === null ? undefined : options.apps.get(resourceUri);
  const sessionId = url.searchParams.get("sessionId");
  const instance = sessionId === null ? undefined : options.sessions.get(sessionId);
  if (
    resourceUri === null ||
    app === undefined ||
    instance?.resourceUri !== resourceUri ||
    instance.id !== app.id
  ) {
    writeError(response, 404, "app_unknown");
    return;
  }
  try {
    const resource = await readValidatedResource(
      resourceUri,
      options.config,
      options.dependencies.readResource,
      options.dependencies.onCode,
    );
    if (resource === undefined) {
      writeError(response, 422, "app_resource_invalid");
      return;
    }
    writeJson(response, 200, {
      appId: instance.id,
      sessionId: instance.sessionId,
      resourceUri,
      allow: app.allow,
      html: resource.html,
      csp: resource.csp,
      permissions: resource.permissions,
      telemetry: app.telemetry,
      ...(app.telemetry && instance.uiSession?.traceparent !== undefined
        ? { traceparent: instance.uiSession.traceparent }
        : {}),
      toolInput: options.dependencies.toolInput ?? {},
      toolResult: options.dependencies.toolResult ?? null,
    });
  } catch {
    writeError(response, 502, "app_resource_unavailable");
  }
}

function endAppSession(
  url: URL,
  response: HostResponse,
  options: StatefulRequestHandlerOptions,
): void {
  const sessionId = url.searchParams.get("sessionId");
  const instance = sessionId === null ? undefined : options.sessions.get(sessionId);
  if (instance === undefined) {
    writeError(response, 404, "app_unknown");
    return;
  }
  options.resourceUpdateSubscriptions.get(instance.sessionId)?.();
  options.resourceUpdateSubscriptions.delete(instance.sessionId);
  instance.end();
  writeJson(response, 200, {});
}

async function subscribeResourceUpdates(
  request: HostRequest,
  response: HostResponse,
  options: StatefulRequestHandlerOptions,
): Promise<void> {
  const body = await readBody(request, MAX_CALL_BYTES);
  if (body === undefined) {
    writeError(response, 413, "app_request_too_large");
    return;
  }
  let subscription: z.infer<typeof ResourceUpdateSubscriptionSchema>;
  try {
    subscription = parseJson(ResourceUpdateSubscriptionSchema, body, {
      maxBytes: MAX_CALL_BYTES,
    });
  } catch {
    writeError(response, 400, "app_request_invalid");
    return;
  }
  const instance = options.sessions.get(subscription.sessionId);
  if (instance === undefined) {
    writeError(response, 404, "app_unknown");
    return;
  }
  const subscribe = options.dependencies.subscribeResourceUpdates;
  if (subscribe === undefined) {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }

  options.resourceUpdateSubscriptions.get(instance.sessionId)?.();
  let writeReady = false;
  let updatePending = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const writeUpdate = (): void => {
    if (!closed && writeReady) {
      response.write(`data: ${JSON.stringify({ uri: subscription.resourceUri })}\n\n`);
    } else if (!closed) {
      updatePending = true;
    }
  };
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    options.resourceUpdateSubscriptions.delete(instance.sessionId);
    unsubscribe?.();
    response.end();
  };
  try {
    unsubscribe = subscribe(subscription.resourceUri, writeUpdate, close);
  } catch {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }
  if (unsubscribe === undefined) {
    writeError(response, 503, "resource_updates_unavailable");
    return;
  }
  options.resourceUpdateSubscriptions.set(instance.sessionId, close);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.write(": subscribed\n\n");
  writeReady = true;
  if (updatePending) {
    writeUpdate();
  }
  const removeCloseListener = response.onClose?.(close);
  if (removeCloseListener === undefined) {
    return;
  }
  const unsubscribeAndRemoveListener = options.resourceUpdateSubscriptions.get(instance.sessionId);
  if (unsubscribeAndRemoveListener !== undefined) {
    options.resourceUpdateSubscriptions.set(instance.sessionId, () => {
      removeCloseListener();
      unsubscribeAndRemoveListener();
    });
  }
}

async function routeAppCall(
  request: HostRequest,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
  const body = await readBody(request, MAX_CALL_BYTES);
  if (body === undefined) {
    countHostAppRejected("size");
    try {
      options.dependencies.onAppRejected?.("size");
    } catch {
      writeError(response, 413, "app_call_too_large");
      return;
    }
    writeError(response, 413, "app_call_too_large");
    return;
  }
  let call: AppCall;
  try {
    call = parseJson(AppCallSchema, body, { maxBytes: MAX_CALL_BYTES });
  } catch {
    countHostAppRejected("schema");
    try {
      options.dependencies.onAppRejected?.("schema");
    } catch {
      writeError(response, 400, "app_call_invalid");
      return;
    }
    writeError(response, 400, "app_call_invalid");
    return;
  }
  const session = options.sessions.get(call.sessionId);
  if (session?.id !== call.appId) {
    countHostAppRejected("unknown_app");
    try {
      options.dependencies.onAppRejected?.("unknown_app");
    } catch {
      writeError(response, 404, "app_unknown");
      return;
    }
    writeError(response, 404, "app_unknown");
    return;
  }
  try {
    writeJson(response, 200, await options.appCallRouter.handle(session, call));
  } catch (error) {
    if (error instanceof AppCallRouterError) {
      let status = 409;
      if (error.code === "rate_limited") {
        status = 429;
      } else if (error.code === "app_tool_not_allowed") {
        status = 403;
      }
      writeError(response, status, error.code);
      return;
    }
    writeJson(response, 200, { content: [], isError: true });
  }
}

async function routeAppToolsList(
  url: URL,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  const session = sessionId === null ? undefined : options.sessions.get(sessionId);
  if (session === undefined) {
    writeError(response, 404, "app_unknown");
    return;
  }
  try {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    writeJson(response, 200, await options.appCallRouter.listTools(session, cursor));
  } catch {
    writeError(response, 502, "app_tools_unavailable");
  }
}

async function routeAppRequest(
  request: HostRequest,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
  const body = await readBody(request, MAX_CALL_BYTES);
  if (body === undefined) {
    options.appRequestRouter.reject("request_invalid");
    writeError(response, 413, "app_request_too_large");
    return;
  }
  let appRequest: ReturnType<typeof AppRequestSchema.parse>;
  try {
    appRequest = parseJson(AppRequestSchema, body, { maxBytes: MAX_CALL_BYTES });
  } catch {
    options.appRequestRouter.reject("request_invalid");
    writeJson(response, 200, { allowed: false });
    return;
  }
  const session = options.sessions.get(appRequest.sessionId);
  if (session === undefined) {
    options.appRequestRouter.reject("unknown_app");
    writeJson(response, 200, { allowed: false });
    return;
  }
  if (!options.rateLimiter.tryAcquireBatch(session.sessionId)) {
    options.appRequestRouter.reject("rate");
    writeError(response, 429, "rate_limited");
    return;
  }
  writeJson(response, 200, await options.appRequestRouter.handle(session, appRequest));
}

/** Creates the authenticated static/API request handler for a single host process. */
export function createRequestHandler(
  options: RequestHandlerOptions,
): (request: HostRequest, response: HostResponse) => Promise<void> {
  const readStatic = options.dependencies.readStatic ?? readStaticAsset;
  const requestOptions = {
    ...options,
    resourceUpdateSubscriptions: new Map<string, () => void>(),
  };
  return async (request, response) => {
    try {
      if (!requestOptions.expectedHosts().includes(request.headers.host ?? "")) {
        writeError(response, 403, "app_host_invalid");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await handleStaticRequest(request, response, readStatic)) {
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        writeError(response, 404, "not_found");
        return;
      }
      if (!isAuthorizedApiRequest(request, requestOptions)) {
        writeError(response, 403, "app_unauthorized");
        return;
      }
      switch (`${request.method ?? ""} ${url.pathname}`) {
        case "GET /api/events":
          sendAppEvents(url, response, requestOptions);
          return;
        case "GET /api/app":
          await sendAppResource(url, response, requestOptions);
          return;
        case "POST /api/call":
          await routeAppCall(request, response, requestOptions);
          return;
        case "POST /api/request":
          await routeAppRequest(request, response, requestOptions);
          return;
        case "GET /api/tools":
          await routeAppToolsList(url, response, requestOptions);
          return;
        case "POST /api/resource-updates":
          await subscribeResourceUpdates(request, response, requestOptions);
          return;
        case "POST /api/session/end":
          endAppSession(url, response, requestOptions);
          return;
        default:
          writeError(response, 404, "not_found");
      }
    } catch {
      writeError(response, 500, "app_host_request_failed");
    }
  };
}
