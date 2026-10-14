// SPDX-License-Identifier: Apache-2.0
import { getDomain } from "tldts";
import { z } from "zod";
import type {
  McpUiHostContext,
  McpUiRequestDisplayModeRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { AppIframe } from "./bridge.js";

export const MAX_FRAME_WIDTH = 1024;
export const MAX_FRAME_HEIGHT = 768;

/** Destination data shown to a user before an app link can be opened. */
export interface OpenLinkDetails {
  readonly url: string;
  readonly registrableDomain: string;
  readonly punycodeWarning: boolean;
}

/** Formats a safe external URL for the host's explicit consent UI. */
export function describeOpenLink(value: string): OpenLinkDetails | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return {
      url: url.href,
      registrableDomain: getDomain(url.hostname) ?? url.hostname,
      punycodeWarning: /(?:^|\.)xn--/iu.test(url.hostname),
    };
  } catch {
    return undefined;
  }
}

/** Clamps an app-requested iframe size to finite host limits. */
export function clampAppSize(
  width: number | undefined,
  height: number | undefined,
  maxWidth: number,
  maxHeight: number,
): { readonly width?: number; readonly height?: number } {
  return {
    ...(width === undefined ? {} : { width: clampDimension(width, maxWidth) }),
    ...(height === undefined ? {} : { height: clampDimension(height, maxHeight) }),
  };
}

function clampDimension(value: number, maximum: number): number {
  return Math.floor(Math.max(1, Math.min(value, maximum)));
}

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
  addEventListener(type: "load" | "error", callback: () => void, options: { once: true }): void;
  setAttribute(name: string, value: string): void;
  srcdoc: string;
};

/** Injected DOM operations needed to mount an app. */
export interface HostPagePort {
  setStatus(code: string): void;
  createFrame: AppIframeFactory;
  onFrameRemoved(callback: () => void): void;
  onPageHide(callback: () => void): void;
  attachFrame(): void;
  getHostContext(): McpUiHostContext;
  onHostContextChange(callback: (context: McpUiHostContext) => void): () => void;
  confirmOpenLink(details: OpenLinkDetails, open: (url: string) => boolean): Promise<boolean>;
  resizeFrame(width: number | undefined, height: number | undefined): void;
  setDisplayMode(mode: McpUiRequestDisplayModeRequest["params"]["mode"]): Promise<
    McpUiRequestDisplayModeRequest["params"]["mode"]
  >;
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

/** Builds the authenticated request headers for the host's local channel. */
export function authorizedHeaders(token: string): Record<string, string> {
  return { authorization: ["Bearer", token].join(" ") };
}

/** Ends a host UI session without retaining or exposing request details. */
export function endUiSession(
  request: typeof fetch,
  sessionId: string,
  headers: Record<string, string>,
  keepalive = false,
): void {
  void request(`/api/session/end?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers,
    ...(keepalive ? { keepalive: true } : {}),
  }).catch(() => undefined);
}
