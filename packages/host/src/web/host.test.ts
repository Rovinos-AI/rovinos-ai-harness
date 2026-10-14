// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { parseJson } from "@harness/schemas";
import type { z } from "zod";
import {
  APP_CSP,
  clampAppSize,
  createSandboxDocument,
  describeOpenLink,
  parseLaunchDetails,
  type OpenLinkDetails,
  type HostPagePort,
} from "./host.js";
import { mountReferenceApp } from "./host-app.js";
import { startReferenceHostPage } from "./host-page.js";
import { createHostContext } from "../server/host-context.js";
import type { AppBridgeHandlers } from "./bridge.js";

const bridgeMock = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  initialized: vi.fn<() => Promise<void>>(),
  sendToolInput: vi.fn<(input: Readonly<Record<string, unknown>>) => Promise<void>>(),
  sendToolResult: vi.fn<(result: z.infer<typeof CallToolResultSchema>) => Promise<void>>(),
  setHostContext: vi.fn<(context: unknown) => void>(),
  toolCall:
    vi.fn<(call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>>(),
  handlers: vi.fn<(handlers: AppBridgeHandlers) => void>(),
}));

vi.mock("./bridge.js", () => ({
  createAppBridge: vi.fn(
    (
      _frame: unknown,
      handler: (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>,
      _listTools: unknown,
      handlers: unknown,
    ) => {
      bridgeMock.toolCall.mockImplementation(handler);
      bridgeMock.handlers(handlers);
      return {
        connect: bridgeMock.connect,
        initialized: bridgeMock.initialized(),
        sendToolInput: bridgeMock.sendToolInput,
        sendToolResult: bridgeMock.sendToolResult,
        setHostContext: bridgeMock.setHostContext,
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
  allow: { openLink: false, message: false, modelContext: false },
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

class FakeDomNode extends EventTarget {
  readonly tagName: string;
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly #listeners = new Map<string, ((event: Event) => void)[]>();
  #textContent = "";
  #srcdoc = "";
  isConnected = true;
  clientWidth = 0;
  clientHeight = 0;
  contentWindow: EventTarget | null;
  className = "";
  id = "";
  type = "";
  open = false;
  requestFullscreen: () => Promise<void> = () => Promise.resolve();

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    this.contentWindow = this.tagName === "IFRAME" ? new EventTarget() : null;
  }

  get textContent(): string {
    return `${this.#textContent}${this.children
      .map((child) => (child instanceof FakeDomNode ? child.textContent : String(child)))
      .join("")}`;
  }

  set textContent(value: string | null) {
    this.#textContent = value ?? "";
    this.children.length = 0;
  }

  get srcdoc(): string {
    return this.#srcdoc;
  }

  set srcdoc(value: string) {
    this.#srcdoc = value;
    queueMicrotask(() => {
      this.dispatch("load");
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }
    const listeners = this.#listeners.get(type) ?? [];
    if (typeof listener === "function") {
      listeners.push(listener);
    } else {
      listeners.push((event) => {
        listener.handleEvent(event);
      });
    }
    this.#listeners.set(type, listeners);
  }

  dispatch(type: string, target: EventTarget | null = this): void {
    const event = new Event(type);
    Object.defineProperty(event, "target", { value: target });
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  closest(selector: string): FakeDomNode | null {
    return selector === "button" && this.tagName === "BUTTON" ? this : null;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  remove(): void {
    this.isConnected = false;
  }
}

function createFakeRoot(frameEvent: "load" | "error" = "load", consentOpenLink = false): {
  readonly root: HostPagePort;
  readonly frame: FakeFrame;
  readonly status: () => string;
  readonly attached: () => boolean;
  readonly frameRemoved: () => void;
  readonly pageHide: () => void;
  readonly contextChanged: () => void;
  readonly confirmedLinks: () => readonly OpenLinkDetails[];
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
  let onContextChanged = (_context: ReturnType<typeof createHostContext>): void => undefined;
  const confirmedLinks: OpenLinkDetails[] = [];
  const context = createHostContext({
    theme: "light",
    locale: "en-US",
    timeZone: "UTC",
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    maxWidth: 800,
    maxHeight: 600,
  });
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
    getHostContext: () => context,
    onHostContextChange(callback) {
      onContextChanged = callback;
      return () => {
        onContextChanged = (): void => undefined;
      };
    },
    confirmOpenLink: (details, open) => {
      confirmedLinks.push(details);
      return Promise.resolve(consentOpenLink && open(details.url));
    },
    resizeFrame(width, height) {
      if (width !== undefined) {
        frame.attributes.set("width", String(width));
      }
      if (height !== undefined) {
        frame.attributes.set("height", String(height));
      }
    },
    setDisplayMode: (mode) => Promise.resolve(mode),
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
    contextChanged: () => {
      onContextChanged(context);
    },
    confirmedLinks: () => confirmedLinks,
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
  bridgeMock.initialized.mockReset().mockResolvedValue();
  bridgeMock.sendToolInput.mockReset().mockResolvedValue();
  bridgeMock.sendToolResult.mockReset().mockResolvedValue();
  bridgeMock.setHostContext.mockReset();
  bridgeMock.toolCall.mockReset();
  bridgeMock.handlers.mockReset();
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

  it("shows the full URL with its registrable domain and a punycode warning", () => {
    expect(describeOpenLink("https://shop.example.co.uk/path?q=1")).toEqual({
      url: "https://shop.example.co.uk/path?q=1",
      registrableDomain: "example.co.uk",
      punycodeWarning: false,
    });
    expect(describeOpenLink("https://xn--bcher-kva.example.test")).toMatchObject({
      registrableDomain: "example.test",
      punycodeWarning: true,
    });
    expect(describeOpenLink("javascript:alert(1)")).toBeUndefined();
    expect(describeOpenLink("******example.test")).toBeUndefined();
  });

  it("opens an opted-in app link only after host confirmation", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const { root, confirmedLinks } = createFakeRoot("load", true);
    const request = successfulRequest({
      ...appPayload,
      allow: { openLink: true, message: false, modelContext: false },
    });
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true })));
    const handlers = bridgeMock.handlers.mock.calls[0]?.[0];
    if (handlers === undefined) {
      throw new Error("Host app request handlers were not installed.");
    }
    await expect(handlers.onOpenLink("https://shop.example.co.uk/path?q=1")).resolves.toBe(true);
    expect(confirmedLinks()).toEqual([
      {
        url: "https://shop.example.co.uk/path?q=1",
        registrableDomain: "example.co.uk",
        punycodeWarning: false,
      },
    ]);
    expect(open).toHaveBeenCalledWith(
      "https://shop.example.co.uk/path?q=1",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not open an opted-in app link when the user declines", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const { root } = createFakeRoot();
    const request = successfulRequest({
      ...appPayload,
      allow: { openLink: true, message: false, modelContext: false },
    });
    expect(await mountReferenceApp(root, launchHash, request)).toBe(true);
    request
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: false })));
    const handlers = bridgeMock.handlers.mock.calls[0]?.[0];
    if (handlers === undefined) {
      throw new Error("Host app request handlers were not installed.");
    }
    await expect(handlers.onOpenLink("https://example.test")).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(4);
    });
    expect(request.mock.calls[3]?.[1]?.body).toContain('"consented":false');
  });

  it("clamps requested dimensions at the host boundary", () => {
    expect(clampAppSize(5000, 900, 1024, 768)).toEqual({ width: 1024, height: 768 });
    expect(clampAppSize(0.5, undefined, 800, 600)).toEqual({ width: 1 });
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

    const handlers = bridgeMock.handlers.mock.calls[0]?.[0];
    expect(handlers?.hostContext).toMatchObject({
      theme: "light",
      locale: "en-US",
      timeZone: "UTC",
      containerDimensions: { maxWidth: 800, maxHeight: 600 },
    });
    expect(handlers?.hostContext.availableDisplayModes).toContain("inline");
    if (handlers === undefined) {
      throw new Error("Host app request handlers were not installed.");
    }
    await expect(handlers.onRequestDisplayMode("fullscreen")).resolves.toBe("fullscreen");
    handlers.onSizeChange({ width: 5000, height: 900 });
    expect(frame.attributes.get("width")).toBe("800");
    expect(frame.attributes.get("height")).toBe("600");
  });

  it("waits for initialized after iframe load before delivering tool input or result", async () => {
    let resolveInitialized: (() => void) | undefined;
    const initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    bridgeMock.initialized.mockReturnValue(initialized);
    const { root, frame } = createFakeRoot();
    const mounting = mountReferenceApp(root, launchHash, successfulRequest());
    await vi.waitFor(() => {
      expect(frame.srcdoc).toContain(appPayload.html);
    });
    expect(bridgeMock.sendToolInput).not.toHaveBeenCalled();
    expect(bridgeMock.sendToolResult).not.toHaveBeenCalled();
    if (resolveInitialized === undefined) {
      throw new Error("The initialized promise resolver was not created.");
    }
    resolveInitialized();
    await expect(mounting).resolves.toBe(true);
    expect(bridgeMock.sendToolInput).toHaveBeenCalledWith(appPayload.toolInput);
    expect(bridgeMock.sendToolResult).toHaveBeenCalledWith(appPayload.toolResult);
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

  it("updates browser context, clamps sizes, and requires consent in the host dialog", async () => {
    const element = new FakeDomNode("main");
    element.clientWidth = 900;
    element.clientHeight = 600;
    const documentElement = new FakeDomNode("html");
    const body = new FakeDomNode("body");
    const created: FakeDomNode[] = [];
    let fullscreenElement: FakeDomNode | null = null;
    const documentStub = {
      body,
      documentElement,
      fullscreenEnabled: true,
      get fullscreenElement() {
        return fullscreenElement;
      },
      getElementById: () => element,
      createElement: (tagName: string) => {
        const node = new FakeDomNode(tagName);
        created.push(node);
        return node;
      },
      createTextNode: (value: string) => value,
      exitFullscreen: () =>
        Promise.resolve().then(() => {
          fullscreenElement = null;
        }),
    };
    element.requestFullscreen = () =>
      Promise.resolve().then(() => {
        fullscreenElement = element;
      });
    const windowListeners = new Map<string, (event: Event) => void>();
    const mediaListeners: (() => void)[] = [];
    const resizeCallbacks: (() => void)[] = [];
    const mutationCallbacks: (() => void)[] = [];
    let resizeObserved = false;
    let mutationObserved = false;
    let mutationDisconnected = false;
    const open = vi.fn(() => null);
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("Element", FakeDomNode);
    vi.stubGlobal("navigator", { language: "en-CA" });
    vi.stubGlobal("window", {
      location: { hash: launchHash },
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        windowListeners.set(type, () => {
          listener(new Event(type));
        });
      },
      matchMedia: () => ({
        matches: true,
        addEventListener: (_type: string, listener: () => void) => {
          mediaListeners.push(listener);
        },
      }),
      open,
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe(): void {
        resizeObserved = true;
      }
    });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) {
        mutationCallbacks.push(callback);
      }
      observe(): void {
        mutationObserved = true;
      }
      disconnect(): void {
        mutationDisconnected = true;
      }
    });
    const request = successfulRequest({
      ...appPayload,
      allow: { openLink: true, message: true, modelContext: true },
    });
    vi.stubGlobal("fetch", request);

    startReferenceHostPage();
    await vi.waitFor(() => {
      expect(bridgeMock.sendToolInput).toHaveBeenCalledWith(appPayload.toolInput);
    });
    const handlers = bridgeMock.handlers.mock.calls[0]?.[0];
    if (handlers === undefined) {
      throw new Error("Host app request handlers were not installed.");
    }
    expect(handlers.hostContext).toMatchObject({
      theme: "dark",
      locale: "en-CA",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { maxWidth: 1024, maxHeight: 768 },
    });
    handlers.onSizeChange({ width: 2000, height: 2000 });
    const frame = created.find((node) => node.tagName === "IFRAME");
    expect(frame?.style).toEqual({ width: "1024px", height: "768px" });

    await expect(handlers.onRequestDisplayMode("fullscreen")).resolves.toBe("fullscreen");
    await expect(handlers.onRequestDisplayMode("inline")).resolves.toBe("inline");
    await expect(handlers.onRequestDisplayMode("pip")).resolves.toBe("inline");
    windowListeners.get("resize")?.();
    windowListeners.get("languagechange")?.();
    windowListeners.get("fullscreenchange")?.();
    mediaListeners[0]?.();
    resizeCallbacks[0]?.();
    expect(resizeObserved).toBe(true);
    expect(bridgeMock.setHostContext).toHaveBeenCalled();

    request.mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true })));
    const link = "https://xn--bcher-kva.example.test/path?q=1";
    const opening = handlers.onOpenLink(link);
    await vi.waitFor(() => {
      expect(body.children.some((node) => node instanceof FakeDomNode && node.tagName === "DIALOG"))
        .toBe(true);
    });
    const dialog = body.children.find(
      (node): node is FakeDomNode => node instanceof FakeDomNode && node.tagName === "DIALOG",
    );
    if (dialog === undefined) {
      throw new Error("The host did not display its link consent dialog.");
    }
    expect(dialog.textContent).toContain(link);
    expect(dialog.textContent).toContain("internationalized punycode domain");
    const destination = dialog.children[1];
    if (!(destination instanceof FakeDomNode)) {
      throw new TypeError("The host consent dialog does not show its destination.");
    }
    const domain = destination.children.find(
      (node): node is FakeDomNode => node instanceof FakeDomNode,
    );
    expect(domain?.className).toBe("registrable-domain");
    const openButton = created.find((node) => node.dataset.action === "open");
    if (openButton === undefined) {
      throw new Error("The host consent dialog has no open button.");
    }
    dialog.dispatch("click", openButton);
    await expect(opening).resolves.toBe(true);

    request
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: false })));
    const declining = handlers.onOpenLink("https://example.test");
    await vi.waitFor(() => {
      expect(
        body.children.filter(
          (node) => node instanceof FakeDomNode && node.tagName === "DIALOG" && node.open,
        ),
      ).toHaveLength(1);
    });
    const cancelButton = created.find((node) => node.dataset.action === "cancel" && node.isConnected);
    const activeDialog = body.children.find(
      (node): node is FakeDomNode =>
        node instanceof FakeDomNode && node.tagName === "DIALOG" && node.open,
    );
    if (cancelButton === undefined || activeDialog === undefined) {
      throw new Error("The host consent dialog is not available for cancellation.");
    }
    activeDialog.dispatch("click", cancelButton);
    await expect(declining).resolves.toBe(false);
    expect(open.mock.calls).toEqual([[link, "_blank", "noopener,noreferrer"]]);
    expect(request.mock.calls.at(-1)?.[1]?.body).toContain('"consented":false');

    windowListeners.get("pagehide")?.();
    const mutationCallback = mutationCallbacks[0];
    if (mutationCallback === undefined || frame === undefined) {
      throw new Error("Host lifecycle observers were not installed.");
    }
    frame.isConnected = false;
    mutationCallback();
    expect(mutationObserved).toBe(true);
    expect(mutationDisconnected).toBe(true);
  });
});
