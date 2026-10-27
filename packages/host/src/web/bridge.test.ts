// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import type { CallToolResult, JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { createAppBridge } from "./bridge.js";

const bridgeMocks = vi.hoisted(() => ({
  connect: vi.fn<(transport: Transport) => Promise<void>>(),
  sendInput: vi.fn<(input: Readonly<Record<string, unknown>>) => Promise<void>>(),
  sendResult: vi.fn<(result: unknown) => Promise<void>>(),
  addEventListener: vi.fn<(event: string, callback: (params: unknown) => void) => void>(),
  getAppCapabilities: vi.fn<() => { readonly availableDisplayModes?: string[] } | undefined>(),
  handleCall:
    vi.fn<(call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>>(),
  handleListTools: vi.fn<(params: { readonly cursor?: string } | undefined) => Promise<unknown>>(),
  handleSubscribe: vi.fn<(params: { readonly resourceUri: string }) => Promise<unknown>>(),
  notification: vi.fn<(notification: unknown) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  handleDisplayMode: vi.fn<(params: { readonly mode: string }) => Promise<unknown>>(),
  handleOpenLink: vi.fn<(params: { readonly url: string }) => Promise<unknown>>(),
  handleMessage: vi.fn<(params: unknown) => Promise<unknown>>(),
  handleUpdateModelContext: vi.fn<(params: unknown) => Promise<unknown>>(),
  setHostContext: vi.fn<(context: unknown) => void>(),
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    set oncalltool(
      handler: (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>,
    ) {
      bridgeMocks.handleCall.mockImplementation(handler);
    }
    setRequestHandler(
      method: string,
      _schemas: unknown,
      handler: (
        params: { readonly cursor?: string } | { readonly resourceUri: string } | undefined,
      ) => Promise<unknown>,
    ) {
      if (method === "tools/list") {
        bridgeMocks.handleListTools.mockImplementation(handler);
      } else {
        bridgeMocks.handleSubscribe.mockImplementation(handler);
      }
    }
    connect = bridgeMocks.connect;
    notification = bridgeMocks.notification;
    close = bridgeMocks.close;
    sendToolInput = bridgeMocks.sendInput;
    sendToolResult = bridgeMocks.sendResult;
    addEventListener = bridgeMocks.addEventListener;
    getAppCapabilities = bridgeMocks.getAppCapabilities;
    set onrequestdisplaymode(handler: (params: { readonly mode: string }) => Promise<unknown>) {
      bridgeMocks.handleDisplayMode.mockImplementation(handler);
    }
    set onopenlink(handler: (params: { readonly url: string }) => Promise<unknown>) {
      bridgeMocks.handleOpenLink.mockImplementation(handler);
    }
    set onmessage(handler: (params: unknown) => Promise<unknown>) {
      bridgeMocks.handleMessage.mockImplementation(handler);
    }
    set onupdatemodelcontext(handler: (params: unknown) => Promise<unknown>) {
      bridgeMocks.handleUpdateModelContext.mockImplementation(handler);
    }
    setHostContext(context: unknown) {
      bridgeMocks.setHostContext(context);
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createAppBridge", () => {
  it("connects the iframe, forwards app calls, and delivers tool input/results", async () => {
    let listener: ((event: Pick<MessageEvent, "source" | "data">) => void) | undefined;
    let removed = false;
    const target = {
      addEventListener: vi.fn(
        (_type: string, onMessage: (event: Pick<MessageEvent, "source" | "data">) => void) => {
          listener = onMessage;
        },
      ),
      removeEventListener: vi.fn(
        (_type: string, onMessage: (event: Pick<MessageEvent, "source" | "data">) => void) => {
          removed = listener === onMessage;
        },
      ),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("window", target);
    bridgeMocks.connect.mockResolvedValue();
    bridgeMocks.sendInput.mockResolvedValue();
    bridgeMocks.sendResult.mockResolvedValue();
    bridgeMocks.addEventListener.mockReset();
    const result: CallToolResult = { content: [{ type: "text", text: "accepted" }] };
    const onToolCall = vi.fn(() => Promise.resolve(result));
    const listedTools = { tools: [] };
    const onListTools = vi.fn(() => Promise.resolve(listedTools));
    const bridge = createAppBridge({ contentWindow: window }, onToolCall, onListTools);
    await bridge.connect();
    await bridge.sendToolInput({ city: "Seattle" });
    await bridge.sendToolResult(result);
    expect(bridgeMocks.connect).toHaveBeenCalledOnce();
    expect(bridgeMocks.sendInput).toHaveBeenCalledWith({ arguments: { city: "Seattle" } });
    expect(bridgeMocks.sendResult).toHaveBeenCalledWith(result);
    expect(bridgeMocks.addEventListener).toHaveBeenCalledWith("sizechange", expect.any(Function));
    await expect(
      bridgeMocks.handleCall({ name: "approve", arguments: { ok: true } }),
    ).resolves.toBe(result);
    expect(onToolCall).toHaveBeenCalledWith({ name: "approve", arguments: { ok: true } });
    await expect(bridgeMocks.handleListTools({ cursor: "next" })).resolves.toBe(listedTools);
    expect(onListTools).toHaveBeenCalledWith("next");

    const transport = bridgeMocks.connect.mock.calls[0]?.[0];
    expect(transport).toBeDefined();
    if (transport === undefined) {
      throw new Error("The MCP Apps transport was not created.");
    }
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    await transport.start();
    expect(target.addEventListener).toHaveBeenCalledOnce();
    const request = JSONRPCMessageSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "approve", arguments: { ok: true } },
    });
    listener?.({ source: window, data: request });
    listener?.({ source: null, data: request });
    listener?.({ source: window, data: "not a message" });
    expect(received).toEqual([request]);
    await transport.send(request);
    expect(target.postMessage).toHaveBeenCalledWith(request, "*");
    const closed = vi.fn();
    transport.onclose = closed;
    await transport.close();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
    expect(removed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("relays run resource updates to the view and disposes the subscription", async () => {
    let update: (() => void) | undefined;
    let closeSubscription: (() => void) | undefined;
    const unsubscribe = vi.fn();
    bridgeMocks.handleSubscribe.mockReset();
    bridgeMocks.notification.mockReset().mockResolvedValue();
    bridgeMocks.close.mockReset().mockResolvedValue();
    bridgeMocks.connect.mockResolvedValue();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    });
    const bridge = createAppBridge(
      { contentWindow: window },
      () => Promise.resolve({ content: [] }),
      () => Promise.resolve({ tools: [] }),
      {
        hostContext: {},
        onOpenLink: () => Promise.resolve(false),
        onMessage: () => Promise.resolve(false),
        onUpdateModelContext: () => Promise.resolve(false),
        onRequestDisplayMode: (mode) => Promise.resolve(mode),
        getCurrentDisplayMode: () => "inline",
        onSizeChange: () => undefined,
        subscribeResourceUpdates: (_uri, onUpdate, onClose) => {
          update = onUpdate;
          closeSubscription = onClose;
          return Promise.resolve(unsubscribe);
        },
      },
    );
    await bridge.connect();
    await expect(bridgeMocks.handleSubscribe({ resourceUri: "harness://runs" })).resolves.toEqual({
      subscribed: true,
    });

    update?.();
    closeSubscription?.();
    expect(bridgeMocks.notification).toHaveBeenNthCalledWith(1, {
      method: "notifications/resources/updated",
      params: { uri: "harness://runs" },
    });
    expect(bridgeMocks.notification).toHaveBeenNthCalledWith(2, {
      method: "harness/resources/subscription_closed",
      params: { resourceUri: "harness://runs" },
    });
    await bridge.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(bridgeMocks.close).toHaveBeenCalledOnce();
  });

  it("refuses to connect when the iframe has no content window", () => {
    expect(() =>
      createAppBridge({ contentWindow: null }, () => Promise.resolve({ content: [] })),
    ).toThrow("The app iframe has no content window.");
  });

  it("exposes initialized and ignores display modes not negotiated by the view", async () => {
    let initializedListener: ((params: unknown) => void) | undefined;
    bridgeMocks.addEventListener.mockReset().mockImplementation((event, callback) => {
      if (event === "initialized") {
        initializedListener = callback;
      }
    });
    bridgeMocks.getAppCapabilities.mockReturnValue({ availableDisplayModes: ["inline"] });
    bridgeMocks.handleDisplayMode.mockReset();
    bridgeMocks.connect.mockResolvedValue();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    });
    const onRequestDisplayMode = vi.fn((mode: "inline" | "fullscreen" | "pip") =>
      Promise.resolve(mode),
    );
    const bridge = createAppBridge(
      { contentWindow: window },
      () => Promise.resolve({ content: [] }),
      () => Promise.resolve({ tools: [] }),
      {
        hostContext: {
          theme: "light",
          displayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
        },
        onOpenLink: () => Promise.resolve(false),
        onMessage: () => Promise.resolve(false),
        onUpdateModelContext: () => Promise.resolve(false),
        onRequestDisplayMode,
        getCurrentDisplayMode: () => "fullscreen",
        onSizeChange: () => undefined,
      },
    );
    let initialized = false;
    void bridge.initialized.then(() => {
      initialized = true;
    });
    await bridge.connect();
    expect(initialized).toBe(false);
    if (initializedListener === undefined) {
      throw new Error("The initialized event listener was not registered.");
    }
    initializedListener({});
    await bridge.initialized;
    expect(initialized).toBe(true);
    await expect(bridgeMocks.handleDisplayMode({ mode: "fullscreen" })).resolves.toEqual({
      mode: "fullscreen",
    });
    expect(onRequestDisplayMode).not.toHaveBeenCalled();
  });

  it("routes app requests and host context changes through their handlers", async () => {
    let sizeChange: ((params: { readonly width?: number; readonly height?: number }) => void) | undefined;
    bridgeMocks.connect.mockResolvedValue();
    bridgeMocks.addEventListener.mockReset().mockImplementation((event, callback) => {
      if (event === "sizechange") {
        sizeChange = callback;
      }
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    });
    const onOpenLink = vi.fn(() => Promise.resolve(true));
    const onMessage = vi.fn(() => Promise.resolve(true));
    const onUpdateModelContext = vi.fn(() => Promise.resolve(true));
    const onSizeChange = vi.fn();
    const bridge = createAppBridge(
      { contentWindow: window },
      () => Promise.resolve({ content: [] }),
      undefined,
      {
        hostContext: {},
        onOpenLink,
        onMessage,
        onUpdateModelContext,
        onRequestDisplayMode: (mode) => Promise.resolve(mode),
        getCurrentDisplayMode: () => "inline",
        onSizeChange,
      },
    );
    await bridge.connect();

    await expect(bridgeMocks.handleOpenLink({ url: "https://example.test" })).resolves.toEqual({
      isError: false,
    });
    await expect(bridgeMocks.handleMessage({ content: "synthetic" })).resolves.toEqual({
      isError: false,
    });
    await expect(
      bridgeMocks.handleUpdateModelContext({ content: "synthetic" }),
    ).resolves.toEqual({});
    onUpdateModelContext.mockResolvedValue(false);
    await expect(
      bridgeMocks.handleUpdateModelContext({ content: "rejected" }),
    ).rejects.toThrow("app_request_rejected");

    sizeChange?.({ width: 640, height: 480 });
    bridge.setHostContext({ theme: "dark" });
    expect(onOpenLink).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onUpdateModelContext).toHaveBeenCalledTimes(2);
    expect(onSizeChange).toHaveBeenCalledWith({ width: 640, height: 480 });
    expect(bridgeMocks.setHostContext).toHaveBeenCalledWith({ theme: "dark" });
    await bridge.close();
  });
});
