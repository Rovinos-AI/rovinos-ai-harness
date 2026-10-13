// SPDX-License-Identifier: Apache-2.0
import {
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import { AppBridge, type McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolRequest,
  CallToolResult,
  JSONRPCMessage,
  ListToolsResult,
  Transport,
} from "@modelcontextprotocol/client";

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

class AppPostMessageTransport implements Transport {
  readonly #target: Window;
  readonly #listener: (event: Pick<MessageEvent, "source" | "data">) => void;
  #started = false;
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  sessionId: Transport["sessionId"];
  setProtocolVersion: Transport["setProtocolVersion"];
  setSupportedProtocolVersions: Transport["setSupportedProtocolVersions"];

  constructor(target: Window) {
    this.#target = target;
    this.#listener = (event) => {
      if (event.source !== this.#target) {
        return;
      }
      const parsed = JSONRPCMessageSchema.safeParse(event.data);
      if (parsed.success) {
        this.onmessage?.(parsed.data);
      }
    };
  }

  start(): Promise<void> {
    if (!this.#started) {
      window.addEventListener("message", this.#listener);
      this.#started = true;
    }
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.#target.postMessage(message, "*");
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#started) {
      window.removeEventListener("message", this.#listener);
      this.#started = false;
    }
    this.onclose?.();
    return Promise.resolve();
  }
}

/**
 * Connects an iframe to the official MCP Apps host bridge with only tool forwarding enabled.
 *
 * @param frame - The sandboxed MCP App iframe.
 * @param onToolCall - Handler that routes calls through the host's local channel.
 * @param onListTools - Lists only the tools exposed by the host to this app.
 * @returns Methods for connecting and delivering tool input and result notifications.
 */
export function createAppBridge(
  frame: AppIframe,
  onToolCall: (call: AppToolCall) => Promise<CallToolResult>,
  onListTools: (cursor: string | undefined) => Promise<ListToolsResult> = () =>
    Promise.resolve({ tools: [] }),
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
  bridge.setRequestHandler(
    "tools/list",
    {
      params: ListToolsRequestSchema.shape.params,
      result: ListToolsResultSchema,
    },
    (params) => onListTools(params?.cursor),
  );
  const transport = new AppPostMessageTransport(target);
  return {
    connect: () => bridge.connect(transport),
    sendToolInput: (input) => bridge.sendToolInput({ arguments: { ...input } }),
    sendToolResult: (result) => bridge.sendToolResult(result),
  };
}
