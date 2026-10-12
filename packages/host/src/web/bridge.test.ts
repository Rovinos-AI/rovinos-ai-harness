// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createAppBridge } from "./bridge.js";

const bridgeMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  sendInput: vi.fn<(input: Readonly<Record<string, unknown>>) => Promise<void>>(),
  sendResult: vi.fn<(result: unknown) => Promise<void>>(),
  handleCall: vi.fn<
    (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
  >(),
  createTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    set oncalltool(
      handler: (call: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>,
    ) {
      bridgeMocks.handleCall.mockImplementation(handler);
    }
    connect = bridgeMocks.connect;
    sendToolInput = bridgeMocks.sendInput;
    sendToolResult = bridgeMocks.sendResult;
  },
  PostMessageTransport: class {
    constructor(target: Window, source: Window) {
      bridgeMocks.createTransport(target, source);
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createAppBridge", () => {
  it("connects the iframe, forwards app calls, and delivers tool input/results", async () => {
    vi.stubGlobal("window", {});
    bridgeMocks.connect.mockResolvedValue();
    bridgeMocks.sendInput.mockResolvedValue();
    bridgeMocks.sendResult.mockResolvedValue();
    const result: CallToolResult = { content: [{ type: "text", text: "accepted" }] };
    const onToolCall = vi.fn(async () => result);
    const bridge = createAppBridge({ contentWindow: window }, onToolCall);
    await bridge.connect();
    await bridge.sendToolInput({ city: "Seattle" });
    await bridge.sendToolResult(result);
    expect(bridgeMocks.createTransport).toHaveBeenCalledOnce();
    expect(bridgeMocks.connect).toHaveBeenCalledOnce();
    expect(bridgeMocks.sendInput).toHaveBeenCalledWith({ arguments: { city: "Seattle" } });
    expect(bridgeMocks.sendResult).toHaveBeenCalledWith(result);
    await expect(bridgeMocks.handleCall({ name: "approve", arguments: { ok: true } })).resolves.toBe(
      result,
    );
    expect(onToolCall).toHaveBeenCalledWith({ name: "approve", arguments: { ok: true } });
  });

  it("refuses to connect when the iframe has no content window", () => {
    expect(() => createAppBridge({ contentWindow: null }, async () => ({ content: [] }))).toThrow(
      "The app iframe has no content window.",
    );
  });
});
