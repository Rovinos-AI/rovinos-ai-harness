// SPDX-License-Identifier: Apache-2.0
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/core";
import { INVALID_REQUEST, ProtocolError } from "@modelcontextprotocol/client";
import { Code, Id, Traceparent, parseJson } from "@harness/schemas";
import { AppRequestResultSchema } from "../shared/app-request.js";
import { z } from "zod";
import {
  createAppBridge,
  type AppBridgeHandlers,
  type AppToolCall,
} from "./bridge.js";
import {
  MAX_FRAME_HEIGHT,
  MAX_FRAME_WIDTH,
  authorizedHeaders,
  clampAppSize,
  createSandboxDocument,
  describeOpenLink,
  endUiSession,
  parseLaunchDetails,
  type AppIframeFactory,
  type HostPagePort,
  type LaunchDetails,
} from "./host.js";

const AppPayloadSchema = z
  .object({
    appId: Code,
    sessionId: Id,
    resourceUri: z.string().startsWith("ui://"),
    html: z.string(),
    csp: z.string(),
    permissions: z.array(Code),
    toolInput: z.record(z.string(), z.unknown()),
    toolResult: CallToolResultSchema.nullable(),
    telemetry: z.boolean(),
    traceparent: Traceparent.optional(),
    allow: z
      .object({
        openLink: z.boolean(),
        message: z.boolean(),
        modelContext: z.boolean(),
      })
      .strict(),
  })
  .strict();
const CallResponseSchema = CallToolResultSchema;
const AppCallErrorSchema = z
  .object({
    error: z.enum(["app_tool_not_allowed", "app_run_mismatch", "app_run_unavailable"]),
  })
  .strict();
const HostReadySchema = z.object({ appId: Code, sessionId: Id }).strict();
type AppPayload = z.infer<typeof AppPayloadSchema>;

function toolResultForApp(
  result: NonNullable<z.infer<typeof CallToolResultSchema>>,
  app: Pick<AppPayload, "telemetry" | "traceparent">,
): z.infer<typeof CallToolResultSchema> {
  const { _meta, ...resultWithoutMetadata } = result;
  const metadata = { ..._meta };
  delete metadata.traceparent;
  delete metadata.tracestate;
  delete metadata.baggage;
  if (app.telemetry && app.traceparent !== undefined) {
    metadata.traceparent = app.traceparent;
  }
  return {
    ...resultWithoutMetadata,
    ...(Object.keys(metadata).length === 0 ? {} : { _meta: metadata }),
  };
}

function waitForFrameLoad(frame: ReturnType<AppIframeFactory>): Promise<void> {
  return new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener(
      "error",
      () => {
        reject(new Error("App iframe failed to load."));
      },
      { once: true },
    );
  });
}

interface AppRequestContext {
  readonly app: AppPayload;
  readonly launch: LaunchDetails;
  readonly request: typeof fetch;
}

function createAppRequest(context: AppRequestContext): (
  body: Readonly<Record<string, unknown>>,
) => Promise<boolean> {
  const request = context.request;
  const headers = authorizedHeaders(context.launch.token);
  const sessionId = context.app.sessionId;
  return async (body) => {
    try {
      const response = await request("/api/request", {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, ...body }),
      });
      if (!response.ok) {
        return false;
      }
      return parseJson(AppRequestResultSchema, await response.text()).allowed;
    } catch {
      return false;
    }
  };
}

function createAppBridgeHandlers(
  root: HostPagePort,
  appRequest: ReturnType<typeof createAppRequest>,
  getHostContext: () => ReturnType<HostPagePort["getHostContext"]>,
): AppBridgeHandlers {
  return {
    hostContext: getHostContext(),
    onOpenLink: async (value) => {
      if (!(await appRequest({ kind: "open_link", url: value }))) {
        return false;
      }
      const details = describeOpenLink(value);
      if (details === undefined) {
        return false;
      }
      const opened = await root.confirmOpenLink(details, (url) => {
        try {
          window.open(url, "_blank", "noopener,noreferrer");
          return true;
        } catch {
          return false;
        }
      });
      if (!opened) {
        void appRequest({ kind: "open_link", consented: false });
      }
      return opened;
    },
    onMessage: (params) => appRequest({ kind: "message", content: params.content }),
    onUpdateModelContext: (params) =>
      appRequest({
        kind: "model_context",
        ...(params.content === undefined ? {} : { content: params.content }),
        ...(params.structuredContent === undefined
          ? {}
          : { structuredContent: params.structuredContent }),
      }),
    onRequestDisplayMode: (mode) => root.setDisplayMode(mode),
    getCurrentDisplayMode: () => getHostContext().displayMode ?? "inline",
    onSizeChange: ({ width, height }) => {
      const dimensions = getHostContext().containerDimensions;
      const maxWidth =
        dimensions !== undefined && "maxWidth" in dimensions && dimensions.maxWidth !== undefined
          ? dimensions.maxWidth
          : MAX_FRAME_WIDTH;
      const maxHeight =
        dimensions !== undefined &&
        "maxHeight" in dimensions &&
        dimensions.maxHeight !== undefined
          ? dimensions.maxHeight
          : MAX_FRAME_HEIGHT;
      const size = clampAppSize(width, height, maxWidth, maxHeight);
      root.resizeFrame(size.width, size.height);
    },
  };
}

interface ConnectAppFrameOptions {
  readonly root: HostPagePort;
  readonly app: AppPayload;
  readonly launch: LaunchDetails;
  readonly request: typeof fetch;
  readonly endSession: () => void;
}

async function connectAppFrame(options: ConnectAppFrameOptions): Promise<void> {
  const { root, app, launch, request, endSession } = options;
  const frame = root.createFrame();
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", `MCP App ${app.appId}`);
  if (app.permissions.length > 0) {
    frame.setAttribute("allow", app.permissions.join("; "));
  }
  let removeContextListener = (): void => undefined;
  root.onFrameRemoved(() => {
    removeContextListener();
    endSession();
  });
  root.attachFrame();
  let hostContext = root.getHostContext();
  const appRequest = createAppRequest({ app, launch, request });
  const handlers = createAppBridgeHandlers(root, appRequest, () => hostContext);
  const bridge = createAppBridge(
    frame,
    (call) => routeToolCall(call, app, launch, request),
    (cursor) => routeToolList(cursor, app.sessionId, launch.token, request),
    handlers,
  );
  await bridge.connect();
  const loaded = waitForFrameLoad(frame);
  frame.srcdoc = createSandboxDocument(app.html, app.csp);
  await loaded;
  removeContextListener = root.onHostContextChange((context) => {
    hostContext = context;
    bridge.setHostContext(context);
  });
  await bridge.initialized;
  await bridge.sendToolInput(app.toolInput);
  if (app.toolResult !== null) {
    await bridge.sendToolResult(toolResultForApp(app.toolResult, app));
  }
}

async function routeToolList(
  cursor: string | undefined,
  sessionId: string,
  token: string,
  request: typeof fetch,
): Promise<z.infer<typeof ListToolsResultSchema>> {
  const query = new URLSearchParams({ sessionId });
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  try {
    const response = await request(`/api/tools?${query.toString()}`, {
      headers: authorizedHeaders(token),
    });
    if (!response.ok) {
      return { tools: [] };
    }
    return parseJson(ListToolsResultSchema, await response.text());
  } catch {
    return { tools: [] };
  }
}

async function routeToolCall(
  call: AppToolCall,
  app: AppPayload,
  launch: LaunchDetails,
  request: typeof fetch,
): Promise<z.infer<typeof CallResponseSchema>> {
  try {
    const response = await request("/api/call", {
      method: "POST",
      headers: { ...authorizedHeaders(launch.token), "content-type": "application/json" },
      body: JSON.stringify({
        appId: app.appId,
        sessionId: app.sessionId,
        toolName: call.name,
        arguments: call.arguments ?? {},
      }),
    });
    if (!response.ok) {
      const error = parseJson(AppCallErrorSchema, await response.text());
      throw new ProtocolError(INVALID_REQUEST, error.error);
    }
    return parseJson(CallResponseSchema, await response.text());
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }
    return { content: [], isError: true };
  }
}

/**
 * Loads a registered MCP resource and mounts it in an isolated iframe.
 *
 * @param root - Trusted host-page container.
 * @param hash - The launch fragment containing the bearer token and resource URI.
 * @param request - Injectable fetch function for host-channel tests.
 * @returns True if the iframe was mounted; false if launch or server validation failed.
 */
export async function mountReferenceApp(
  root: HostPagePort,
  hash: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const launch = parseLaunchDetails(hash);
  if (launch === undefined) {
    root.setStatus("app_unknown");
    return false;
  }
  const headers = authorizedHeaders(launch.token);
  const channel = await request(
    `/api/events?resourceUri=${encodeURIComponent(launch.resourceUri)}`,
    { headers },
  );
  if (!channel.ok) {
    root.setStatus(channel.status === 404 ? "app_unknown" : "app_unavailable");
    return false;
  }
  const readyLine = (await channel.text())
    .split(/\r?\n/u)
    .find((line) => line.startsWith("data: "));
  if (readyLine === undefined) {
    root.setStatus("app_session_invalid");
    return false;
  }
  let ready: z.infer<typeof HostReadySchema>;
  try {
    ready = parseJson(HostReadySchema, readyLine.slice("data: ".length));
  } catch {
    root.setStatus("app_session_invalid");
    return false;
  }
  let sessionEnded = false;
  const endSession = (keepalive = false): void => {
    if (!sessionEnded) {
      sessionEnded = true;
      endUiSession(request, ready.sessionId, headers, keepalive);
    }
  };
  root.onPageHide(() => {
    endSession(true);
  });
  const appResponse = await request(
    `/api/app?resourceUri=${encodeURIComponent(launch.resourceUri)}&sessionId=${ready.sessionId}`,
    { headers },
  );
  if (!appResponse.ok) {
    root.setStatus(appResponse.status === 404 ? "app_unknown" : "app_unavailable");
    endSession();
    return false;
  }
  let app: AppPayload;
  try {
    app = parseJson(AppPayloadSchema, await appResponse.text());
  } catch {
    root.setStatus("app_resource_invalid");
    endSession();
    return false;
  }
  let launched = false;
  try {
    await connectAppFrame({
      root,
      app,
      launch,
      request,
      endSession: () => {
        endSession();
      },
    });
    launched = true;
    return true;
  } finally {
    if (!launched) {
      endSession();
    }
  }
}
