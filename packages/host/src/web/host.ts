// SPDX-License-Identifier: Apache-2.0
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { Code, Id, parseJson } from "@harness/schemas";
import { z } from "zod";
import { createAppBridge, type AppIframe, type AppToolCall } from "./bridge.js";

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
  })
  .strict();
const CallResponseSchema = CallToolResultSchema;

/** Default restrictions placed on every reference-host app iframe. */
export const APP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

/** Data parsed from the host-only URL fragment. */
export interface LaunchDetails {
  readonly token: string;
  readonly resourceUri: string;
}

/** DOM operations required by the host; kept injectable for deterministic unit tests. */
/** Creates the iframe element used by the page. */
export type AppIframeFactory = () => AppIframe & {
  addEventListener(type: "load", callback: () => void, options: { once: true }): void;
  setAttribute(name: string, value: string): void;
  srcdoc: string;
};

/** Injected DOM operations needed to mount an app. */
export interface HostPagePort {
  setStatus(code: string): void;
  createFrame: AppIframeFactory;
  attachFrame(): void;
}

/** Reads and validates the non-secret resource selection and bearer token from the URL fragment. */
export function parseLaunchDetails(hash: string): LaunchDetails | undefined {
  const values = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = values.get("token");
  const resourceUri = values.get("resourceUri");
  if (token === null || token.length < 32 || resourceUri === null) {
    return undefined;
  }
  const parsedResource = z.string().startsWith("ui://").safeParse(resourceUri);
  return parsedResource.success ? { token, resourceUri: parsedResource.data } : undefined;
}

/** Wraps an MCP resource with its enforced CSP before assigning it to iframe srcdoc. */
export function createSandboxDocument(html: string, csp = APP_CSP): string {
  const policy = csp.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body>${html}</body></html>`;
}

function authorizedHeaders(token: string): HeadersInit {
  return { authorization: ["Bearer", token].join(" ") };
}

async function routeToolCall(
  call: AppToolCall,
  appId: string,
  sessionId: string,
  token: string,
  request: typeof fetch,
): Promise<z.infer<typeof CallResponseSchema>> {
  try {
    const response = await request("/api/call", {
      method: "POST",
      headers: { ...authorizedHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({
        appId,
        sessionId,
        toolName: call.name,
        arguments: call.arguments ?? {},
      }),
    });
    if (!response.ok) {
      return { content: [], isError: true };
    }
    return parseJson(CallResponseSchema, await response.text());
  } catch {
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
    root.setStatus(channel.status === 404 ? "app_unknown" : "app_unauthorized");
    return false;
  }
  const response = await request(
    `/api/app?resourceUri=${encodeURIComponent(launch.resourceUri)}`,
    { headers },
  );
  if (!response.ok) {
    root.setStatus(response.status === 404 ? "app_unknown" : "app_resource_invalid");
    return false;
  }
  let app: z.infer<typeof AppPayloadSchema>;
  try {
    app = parseJson(AppPayloadSchema, await response.text());
  } catch {
    root.setStatus("app_resource_invalid");
    return false;
  }
  const frame = root.createFrame();
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  if (app.permissions.length > 0) {
    frame.setAttribute("allow", app.permissions.join("; "));
  }
  frame.srcdoc = createSandboxDocument(app.html, app.csp);
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  root.attachFrame();
  await loaded;
  const bridge = createAppBridge(frame, (call) =>
    routeToolCall(call, app.appId, app.sessionId, launch.token, request),
  );
  await bridge.connect();
  await bridge.sendToolInput(app.toolInput);
  if (app.toolResult !== null) {
    await bridge.sendToolResult(app.toolResult);
  }
  return true;
}

function startPage(): void {
  const element = document.getElementById("host");
  if (element === null) {
    return;
  }
  let frame: HTMLIFrameElement | undefined;
  const root: HostPagePort = {
    setStatus: (code) => {
      element.textContent = code;
    },
    createFrame: () => {
      frame = document.createElement("iframe");
      return frame;
    },
    attachFrame: () => {
      if (frame !== undefined) {
        element.replaceChildren(frame);
      }
    },
  };
  void mountReferenceApp(root, window.location.hash).catch(() => {
    root.setStatus("host_unavailable");
  });
}

if (typeof document !== "undefined") {
  startPage();
}
