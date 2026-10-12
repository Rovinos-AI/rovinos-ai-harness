// SPDX-License-Identifier: Apache-2.0
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostCapabilities,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/client";

/** A tool-call message received from the untrusted app iframe. */
export type AppToolCall = CallToolRequest["params"];

/** Connected SDK bridge for one sandboxed app iframe. */
export interface ReferenceAppBridge {
  connect(): Promise<void>;
  sendToolInput(input: Readonly<Record<string, unknown>>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
}

/** Minimal iframe surface needed to establish the SDK's host-side transport. */
export interface AppIframe {
  readonly contentWindow: Window | null;
}

/**
 * Connects an iframe to the official MCP Apps host bridge with only tool forwarding enabled.
 *
 * @param frame - The sandboxed MCP App iframe.
 * @param onToolCall - Handler that routes calls through the host's local channel.
 * @returns Methods for connecting and delivering tool input and result notifications.
 */
export function createAppBridge(
  frame: AppIframe,
  onToolCall: (call: AppToolCall) => Promise<CallToolResult>,
): ReferenceAppBridge {
  const target = frame.contentWindow;
  if (target === null) {
    throw new Error("The app iframe has no content window.");
  }
  const capabilities: McpUiHostCapabilities = { serverTools: {} };
  const bridge = new AppBridge(
    null,
    { name: "Rovinos AI Harness", version: "0.0.0" },
    capabilities,
  );
  bridge.oncalltool = (params) => onToolCall(params);
  const transport = new PostMessageTransport(target, target);
  return {
    connect: () => bridge.connect(transport),
    sendToolInput: (input) => bridge.sendToolInput({ arguments: { ...input } }),
    sendToolResult: (result) => bridge.sendToolResult(result),
  };
}
