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
  handleCall:
    vi.fn<(call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>>(),
  handleListTools: vi.fn<(params: { readonly cursor?: string } | undefined) => Promise<unknown>>(),
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    set oncalltool(
      handler: (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>,
    ) {
      bridgeMocks.handleCall.mockImplementation(handler);
    }
    setRequestHandler(
      _method: string,
      _schemas: unknown,
      handler: (params: { readonly cursor?: string } | undefined) => Promise<unknown>,
    ) {
      bridgeMocks.handleListTools.mockImplementation(handler);
    }
    connect = bridgeMocks.connect;
    sendToolInput = bridgeMocks.sendInput;
    sendToolResult = bridgeMocks.sendResult;
    addEventListener = bridgeMocks.addEventListener;
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
    expect(bridgeMocks.addEventListener).toHaveBeenCalledWith(
      "sizechange",
      expect.any(Function),
    );
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

  it("refuses to connect when the iframe has no content window", () => {
    expect(() =>
      createAppBridge({ contentWindow: null }, () => Promise.resolve({ content: [] })),
    ).toThrow("The app iframe has no content window.");
  });
});
