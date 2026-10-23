// SPDX-License-Identifier: Apache-2.0
import {
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiMessageRequest,
  type McpUiOpenLinkRequest,
  type McpUiRequestDisplayModeRequest,
  type McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolRequest,
  CallToolResult,
  JSONRPCMessage,
  ListToolsResult,
  Transport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

/** A tool-call message received from the untrusted app iframe. */
export type AppToolCall = CallToolRequest["params"];

/** Connected SDK bridge for one sandboxed app iframe. */
export interface ReferenceAppBridge {
  connect(): Promise<void>;
  readonly initialized: Promise<void>;
  sendToolInput(input: Readonly<Record<string, unknown>>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  setHostContext(context: McpUiHostContext): void;
  close(): Promise<void>;
}

/** Trusted host-page handlers for requests and notifications received from an app. */
export interface AppBridgeHandlers {
  readonly hostContext: McpUiHostContext;
  readonly onOpenLink: (url: string) => Promise<boolean>;
  readonly onMessage: (params: McpUiMessageRequest["params"]) => Promise<boolean>;
  readonly onUpdateModelContext: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => Promise<boolean>;
  readonly onRequestDisplayMode: (
    mode: McpUiRequestDisplayModeRequest["params"]["mode"],
  ) => Promise<McpUiRequestDisplayModeRequest["params"]["mode"]>;
  readonly getCurrentDisplayMode: () => McpUiRequestDisplayModeRequest["params"]["mode"];
  readonly onSizeChange: (params: { readonly width?: number; readonly height?: number }) => void;
  readonly subscribeResourceUpdates?: (
    resourceUri: string,
    onUpdate: () => void,
    onClose: () => void,
  ) => Promise<(() => void) | undefined>;
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
  handlers?: AppBridgeHandlers,
): ReferenceAppBridge {
  const target = frame.contentWindow;
  if (target === null) {
    throw new Error("The app iframe has no content window.");
  }
  const capabilities: McpUiHostCapabilities = {
    serverTools: {},
    openLinks: {},
    message: { text: {} },
    updateModelContext: { text: {}, structuredContent: {} },
  };
  const bridge = new AppBridge(
    null,
    { name: "Rovinos AI Harness", version: "0.0.0" },
    capabilities,
    handlers === undefined ? undefined : { hostContext: handlers.hostContext },
  );
  let unsubscribeResourceUpdates: (() => void) | undefined;
  bridge.oncalltool = (params) => onToolCall(params);
  bridge.onopenlink = async (params: McpUiOpenLinkRequest["params"]) => {
    const allowed = await handlers?.onOpenLink(params.url);
    return { isError: allowed !== true };
  };
  bridge.onmessage = async (params) => {
    const allowed = await handlers?.onMessage(params);
    return { isError: allowed !== true };
  };
  bridge.onupdatemodelcontext = async (params) => {
    if ((await handlers?.onUpdateModelContext(params)) !== true) {
      throw new Error("app_request_rejected");
    }
    return {};
  };
  bridge.onrequestdisplaymode = async (params) => ({
    mode:
      bridge.getAppCapabilities()?.availableDisplayModes?.includes(params.mode) === true &&
      handlers !== undefined
        ? await handlers.onRequestDisplayMode(params.mode)
        : (handlers?.getCurrentDisplayMode() ?? "inline"),
  });
  bridge.addEventListener("sizechange", (params) => {
    handlers?.onSizeChange(params);
  });
  bridge.setRequestHandler(
    "tools/list",
    {
      params: ListToolsRequestSchema.shape.params,
      result: ListToolsResultSchema,
    },
    (params) => onListTools(params?.cursor),
  );
  bridge.setRequestHandler(
    "harness/resources/subscribe",
    {
      params: z.object({ resourceUri: z.literal("harness://runs") }).strict(),
      result: z.object({ subscribed: z.boolean() }).strict(),
    },
    async ({ resourceUri }) => {
      unsubscribeResourceUpdates?.();
      unsubscribeResourceUpdates = undefined;
      try {
        unsubscribeResourceUpdates =
          (await handlers?.subscribeResourceUpdates?.(
            resourceUri,
            () => {
              void bridge
                .notification({
                  method: "notifications/resources/updated",
                  params: { uri: resourceUri },
                })
                .catch(() => undefined);
            },
            () => {
              void bridge
                .notification({
                  method: "harness/resources/subscription_closed",
                  params: { resourceUri },
                })
                .catch(() => undefined);
            },
          )) ?? undefined;
      } catch {
        return { subscribed: false };
      }
      return { subscribed: unsubscribeResourceUpdates !== undefined };
    },
  );
  const transport = new AppPostMessageTransport(target);
  const initialized = new Promise<void>((resolve) => {
    bridge.addEventListener("initialized", () => {
      resolve();
    });
  });
  return {
    connect: () => bridge.connect(transport),
    initialized,
    sendToolInput: (input) => bridge.sendToolInput({ arguments: { ...input } }),
    sendToolResult: (result) => bridge.sendToolResult(result),
    setHostContext: (hostContext) => {
      bridge.setHostContext(hostContext);
    },
    async close() {
      unsubscribeResourceUpdates?.();
      unsubscribeResourceUpdates = undefined;
      await bridge.close();
    },
  };
}
