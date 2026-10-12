// SPDX-License-Identifier: Apache-2.0
import { parseJson, type HostConfig } from "@harness/schemas";
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

const MAX_CALL_BYTES = 16_384;

interface RequestHandlerOptions {
  readonly config: HostConfig;
  readonly dependencies: ReferenceHostDependencies;
  readonly apps: ReadonlyMap<string, AppInstance>;
  readonly appConfigs: ReadonlyMap<string, HostConfig["apps"][number]>;
  readonly sessions: ReadonlyMap<string, AppInstance>;
  readonly token: string;
  readonly expectedOrigin: () => string;
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
  apps: ReadonlyMap<string, AppInstance>,
): void {
  const resourceUri = url.searchParams.get("resourceUri");
  const instance = resourceUri === null ? undefined : apps.get(resourceUri);
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
}

async function sendAppResource(
  url: URL,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
  const resourceUri = url.searchParams.get("resourceUri");
  const instance = resourceUri === null ? undefined : options.apps.get(resourceUri);
  if (resourceUri === null || instance === undefined) {
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
      html: resource.html,
      csp: resource.csp,
      permissions: resource.permissions,
      toolInput: options.dependencies.toolInput ?? {},
      toolResult: options.dependencies.toolResult ?? null,
    });
  } catch {
    writeError(response, 502, "app_resource_unavailable");
  }
}

async function routeAppCall(
  request: HostRequest,
  response: HostResponse,
  options: RequestHandlerOptions,
): Promise<void> {
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
  const session = options.sessions.get(call.sessionId);
  if (session?.id !== call.appId) {
    writeError(response, 404, "app_unknown");
    return;
  }
  if (options.appConfigs.get(session.id)?.allowedTools.includes(call.toolName) !== true) {
    writeError(response, 403, "app_tool_not_allowed");
    return;
  }
  if (options.dependencies.onAppCall === undefined) {
    writeJson(response, 200, { content: [], isError: true });
    return;
  }
  try {
    writeJson(response, 200, await options.dependencies.onAppCall(call));
  } catch {
    writeJson(response, 200, { content: [], isError: true });
  }
}

/** Creates the authenticated static/API request handler for a single host process. */
export function createRequestHandler(options: RequestHandlerOptions): (
  request: HostRequest,
  response: HostResponse,
) => Promise<void> {
  const readStatic =
    options.dependencies.readStatic ??
    readStaticAsset;
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await handleStaticRequest(request, response, readStatic)) {
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        writeError(response, 404, "not_found");
        return;
      }
      if (
        !isSameOrigin(request, options.expectedOrigin()) ||
        !authorizationMatches(request, options.token)
      ) {
        writeError(response, 403, "app_unauthorized");
        return;
      }
      switch (`${request.method ?? ""} ${url.pathname}`) {
        case "GET /api/events":
          sendAppEvents(url, response, options.apps);
          return;
        case "GET /api/app":
          await sendAppResource(url, response, options);
          return;
        case "POST /api/call":
          await routeAppCall(request, response, options);
          return;
        default:
          writeError(response, 404, "not_found");
      }
    } catch {
      writeError(response, 500, "app_host_request_failed");
    }
  };
}
