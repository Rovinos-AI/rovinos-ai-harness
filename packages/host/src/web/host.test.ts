// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { parseJson } from "@harness/schemas";
import type { z } from "zod";
import {
  APP_CSP,
  createSandboxDocument,
  mountReferenceApp,
  parseLaunchDetails,
  startReferenceHostPage,
  type HostPagePort,
} from "./host.js";

const bridgeMock = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  sendToolInput: vi.fn<(input: Readonly<Record<string, unknown>>) => Promise<void>>(),
  sendToolResult: vi.fn<(result: z.infer<typeof CallToolResultSchema>) => Promise<void>>(),
  toolCall:
    vi.fn<(call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>>(),
}));

vi.mock("./bridge.js", () => ({
  createAppBridge: vi.fn(
    (
      _frame: unknown,
      handler: (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>,
    ) => {
      bridgeMock.toolCall.mockImplementation(handler);
      return {
        connect: bridgeMock.connect,
        sendToolInput: bridgeMock.sendToolInput,
        sendToolResult: bridgeMock.sendToolResult,
      };
    },
  ),
}));

const resultSchema = CallToolResultSchema;
const appPayload = {
  appId: "approval",
  sessionId: "00000000000000000000000000",
  resourceUri: "ui://approval/index.html",
  html: "<main>trusted test content</main>",
  csp: APP_CSP,
  permissions: [],
  toolInput: { decision: "approve" },
  toolResult: { content: [{ type: "text", text: "complete" }] },
  telemetry: false,
};
const launchHash = `#${new URLSearchParams({
  token: "t".repeat(43),
  resourceUri: appPayload.resourceUri,
})}`;
const makeLaunchHash = (token: string, resourceUri: string) =>
  `#${new URLSearchParams({ token, resourceUri })}`;

interface FakeFrame {
  readonly contentWindow: Window | null;
  readonly attributes: Map<string, string>;
  srcdoc: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "load" | "error", callback: () => void, options: { once: true }): void;
}

function createFakeRoot(frameEvent: "load" | "error" = "load"): {
  readonly root: HostPagePort;
  readonly frame: FakeFrame;
  readonly status: () => string;
  readonly attached: () => boolean;
  readonly frameRemoved: () => void;
  readonly pageHide: () => void;
} {
  const frame: FakeFrame = {
    contentWindow: null,
    attributes: new Map(),
    srcdoc: "",
    setAttribute(name, value) {
      frame.attributes.set(name, value);
    },
    addEventListener(type, callback) {
      if (type === frameEvent) {
        callback();
      }
    },
  };
  let status = "";
  let attached = false;
  let onFrameRemoved = (): void => undefined;
  let onPageHide = (): void => undefined;
  const root: HostPagePort = {
    setStatus(code) {
      status = code;
    },
    createFrame: () => frame,
    onFrameRemoved(callback) {
      onFrameRemoved = callback;
    },
    onPageHide(callback) {
      onPageHide = callback;
    },
    attachFrame() {
      attached = true;
    },
  };
  return {
    root,
    frame,
    status: () => status,
    attached: () => attached,
    frameRemoved: () => {
      onFrameRemoved();
    },
    pageHide: () => {
      onPageHide();
    },
  };
}

function successfulRequest(payload: unknown = appPayload) {
  const responses = [hostReadyResponse(), new Response(JSON.stringify(payload))];
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(responses.shift() ?? new Response("", { status: 500 })),
  );
}

function hostReadyResponse(): Response {
  return new Response(
    `event: host.ready\ndata: ${JSON.stringify({ appId: appPayload.appId, sessionId: appPayload.sessionId })}\n\n`,
  );
}

beforeEach(() => {
  bridgeMock.connect.mockReset().mockResolvedValue();
  bridgeMock.sendToolInput.mockReset().mockResolvedValue();
  bridgeMock.sendToolResult.mockReset().mockResolvedValue();
  bridgeMock.toolCall.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reference app page", () => {
  it("accepts only a bearer token and ui resource in the launch fragment", () => {
    expect(parseLaunchDetails(launchHash)).toEqual({
      token: "t".repeat(43),
      resourceUri: appPayload.resourceUri,
    });
    expect(parseLaunchDetails(makeLaunchHash("short", "ui://app"))).toBeUndefined();
    expect(parseLaunchDetails(makeLaunchHash("t".repeat(43), "https://bad"))).toBeUndefined();
  });

  it("wraps app HTML with the exact deny-all CSP and escapes the CSP attribute", () => {
    const wrapped = createSandboxDocument("<script>run()</script>");
    expect(wrapped).toContain(`content="${APP_CSP}"`);
    expect(wrapped).toContain("<script>run()</script>");
    expect(createSandboxDocument("x", 'img-src "unsafe" & none')).toContain(
      "img-src &quot;unsafe&quot; &amp; none",
    );
  });

  it("refuses a missing or unknown launch before making requests", async () => {
    const { root, status } = createFakeRoot();
    const request = vi.fn();
    expect(await mountReferenceApp(root, "#invalid", request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(status()).toBe("app_unknown");
  });

  it("rejects unauthorized channel and app responses", async () => {
    const { root } = createFakeRoot();
    const forbidden = vi.fn(() => Promise.resolve(new Response("", { status: 403 })));
    expect(await mountReferenceApp(root, launchHash, forbidden)).toBe(false);
    expect(forbidden).toHaveBeenCalledOnce();

    const unknown = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    expect(await mountReferenceApp(root, launchHash, unknown)).toBe(false);

    const appFailure = vi
      .fn()
      .mockResolvedValueOnce(hostReadyResponse())
      .mockResolvedValueOnce(new Response("", { status: 422 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await mountReferenceApp(root, launchHash, appFailure)).toBe(false);
    await vi.waitFor(() => {
      expect(appFailure).toHaveBeenCalledTimes(3);
    });
    expect(appFailure.mock.calls[2]?.[0]).toBe(
      `/api/session/end?sessionId=${appPayload.sessionId}`,
    );
  });

  it("mounts a sandboxed iframe and connects the MCP Apps bridge", async () => {
    const { root, frame, attached } = createFakeRoot();
    const request = successfulRequest();
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);
    expect(attached()).toBe(true);
    expect(frame.attributes).toEqual(
      new Map([
        ["sandbox", "allow-scripts"],
        ["referrerpolicy", "no-referrer"],
        ["title", "MCP App approval"],
      ]),
    );
    expect(frame.srcdoc).toContain(`content="${APP_CSP}"`);
    expect(frame.srcdoc).toContain(appPayload.html);
    expect(bridgeMock.connect).toHaveBeenCalledOnce();
    expect(bridgeMock.sendToolInput).toHaveBeenCalledWith(appPayload.toolInput);
    expect(bridgeMock.sendToolResult).toHaveBeenCalledWith(appPayload.toolResult);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: ["Bearer", "t".repeat(43)].join(" ") },
    });
  });

  it("sends only opted-in traceparent metadata and ends the session when its frame is removed", async () => {
    const { root, frameRemoved } = createFakeRoot();
    const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const result = {
      content: [{ type: "text" as const, text: "complete" }],
      _meta: {
        traceparent: "00-invalid",
        tracestate: "vendor=value",
        baggage: "private=value",
        preserved: true,
      },
    };
    const request = successfulRequest({
      ...appPayload,
      telemetry: true,
      traceparent,
      toolResult: result,
    });
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);
    expect(bridgeMock.sendToolResult).toHaveBeenCalledWith({
      content: result.content,
      _meta: { preserved: true, traceparent },
    });
    frameRemoved();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(3);
    });
    expect(request.mock.calls[2]?.[0]).toBe(`/api/session/end?sessionId=${appPayload.sessionId}`);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("ends the session with keepalive and authorization when the page is hidden", async () => {
    const { root, pageHide, frameRemoved } = createFakeRoot();
    const request = successfulRequest();
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);

    pageHide();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(3);
    });
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: { authorization: ["Bearer", "t".repeat(43)].join(" ") },
    });
    frameRemoved();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("ends the session when iframe loading or bridge connection fails", async () => {
    const loadFailure = createFakeRoot("error");
    const loadRequest = successfulRequest();
    await expect(mountReferenceApp(loadFailure.root, launchHash, loadRequest)).rejects.toThrow(
      "App iframe failed to load.",
    );
    await vi.waitFor(() => {
      expect(loadRequest).toHaveBeenCalledTimes(3);
    });

    const bridgeFailure = createFakeRoot();
    const bridgeRequest = successfulRequest();
    bridgeMock.connect.mockRejectedValueOnce(new Error("bridge failure"));
    await expect(mountReferenceApp(bridgeFailure.root, launchHash, bridgeRequest)).rejects.toThrow(
      "bridge failure",
    );
    await vi.waitFor(() => {
      expect(bridgeRequest).toHaveBeenCalledTimes(3);
    });
  });

  it("removes trace propagation fields for apps that have not opted in", async () => {
    const { root } = createFakeRoot();
    const result = {
      content: [{ type: "text" as const, text: "complete" }],
      _meta: {
        traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
        tracestate: "vendor=value",
        baggage: "private=value",
        preserved: true,
      },
    };
    expect(
      await mountReferenceApp(
        root,
        launchHash,
        successfulRequest({ ...appPayload, telemetry: false, toolResult: result }),
      ),
    ).toBe(true);
    expect(bridgeMock.sendToolResult).toHaveBeenCalledWith({
      content: result.content,
      _meta: { preserved: true },
    });
  });

  it("delivers no result metadata when an opted-in session has no valid context", async () => {
    const { root } = createFakeRoot();
    const result = {
      content: [{ type: "text" as const, text: "complete" }],
      _meta: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` },
    };
    expect(
      await mountReferenceApp(
        root,
        launchHash,
        successfulRequest({ ...appPayload, telemetry: true, toolResult: result }),
      ),
    ).toBe(true);
    expect(bridgeMock.sendToolResult).toHaveBeenCalledWith({ content: result.content });
  });

  it("handles missing tool results and reports malformed host payloads", async () => {
    const { root } = createFakeRoot();
    const payload = { ...appPayload, toolResult: null };
    expect(await mountReferenceApp(root, launchHash, successfulRequest(payload))).toBe(true);
    expect(bridgeMock.sendToolResult).not.toHaveBeenCalled();

    const invalid = successfulRequest({ ...payload, appId: "invalid app id" });
    expect(await mountReferenceApp(root, launchHash, invalid)).toBe(false);

    const permissionApp = createFakeRoot();
    const permitted = { ...appPayload, toolResult: null, permissions: ["camera"] };
    expect(
      await mountReferenceApp(permissionApp.root, launchHash, successfulRequest(permitted)),
    ).toBe(true);
    expect(permissionApp.frame.attributes.get("allow")).toBe("camera");

    const malformed = vi
      .fn()
      .mockResolvedValueOnce(new Response("event stream"))
      .mockResolvedValueOnce(new Response("{"));
    expect(await mountReferenceApp(root, launchHash, malformed)).toBe(false);
  });

  it("routes calls through the authenticated host channel and handles failures", async () => {
    const { root } = createFakeRoot();
    const request = successfulRequest();
    request.mockResolvedValueOnce(hostReadyResponse());
    request.mockResolvedValueOnce(new Response(JSON.stringify(appPayload)));
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: "text", text: "accepted" }] })),
    );
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);
    const callResult = await bridgeMock.toolCall({ name: "approve", arguments: { ok: true } });
    expect(parseJson(resultSchema, JSON.stringify(callResult)).content).toHaveLength(1);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        appId: appPayload.appId,
        sessionId: appPayload.sessionId,
        toolName: "approve",
        arguments: { ok: true },
      }),
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      `/api/app?resourceUri=${encodeURIComponent(appPayload.resourceUri)}&sessionId=${appPayload.sessionId}`,
    );

    request.mockResolvedValueOnce(new Response("", { status: 403 }));
    expect(await bridgeMock.toolCall({ name: "approve" })).toEqual({ content: [], isError: true });
    request.mockResolvedValueOnce(new Response("{"));
    expect(await bridgeMock.toolCall({ name: "approve" })).toEqual({ content: [], isError: true });
    request.mockRejectedValueOnce(new Error("private request detail"));
    expect(await bridgeMock.toolCall({ name: "approve" })).toEqual({ content: [], isError: true });
  });

  it("starts the browser page, attaches the iframe, and reports startup failures", async () => {
    const { frame } = createFakeRoot();
    let status = "";
    let attached = false;
    const element = {
      set textContent(value: string | null) {
        status = value ?? "";
      },
      get textContent() {
        return status;
      },
      replaceChildren() {
        attached = true;
      },
    };
    vi.stubGlobal("document", {
      getElementById: () => element,
      createElement: () => frame,
    });
    vi.stubGlobal("window", { location: { hash: launchHash }, addEventListener: vi.fn() });
    vi.stubGlobal("fetch", successfulRequest());
    startReferenceHostPage();
    await vi.waitFor(() => {
      expect(attached).toBe(true);
    });
    expect(bridgeMock.sendToolInput).toHaveBeenCalledWith(appPayload.toolInput);

    vi.stubGlobal("document", { getElementById: () => element, createElement: () => frame });
    vi.stubGlobal("window", { location: { hash: launchHash }, addEventListener: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("private browser failure"))),
    );
    startReferenceHostPage();
    await vi.waitFor(() => {
      expect(status).toBe("host_unavailable");
    });

    const missingRootFetch = vi.fn();
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", missingRootFetch);
    startReferenceHostPage();
    expect(missingRootFetch).not.toHaveBeenCalled();
  });
});
