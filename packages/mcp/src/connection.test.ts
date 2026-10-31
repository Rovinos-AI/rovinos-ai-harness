// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { context as otelContext, trace } from "@opentelemetry/api";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { ServerConfigSchema, type JsonValue, type ServerConfig } from "@rovinos/schemas";
import { createTestContextManager, createTestTracerProvider } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnection, McpConnectionError, excludeHeaderDeclaringTools } from "./connection.js";
import { ClientCredentialsExtensionSupport } from "./connection-helpers.js";
import { isConnectionLossError } from "./errors.js";
import * as mcpPackage from "./index.js";

const tracerProvider = createTestTracerProvider();

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];

function legacyElicitInput(
  server: McpServer["server"],
  params: {
    readonly mode: "url";
    readonly elicitationId: string;
    readonly message: string;
    readonly url: string;
  },
): Promise<{ readonly action: string }> {
  const method: unknown = Reflect.get(server, "elicitInput");
  if (typeof method !== "function") {
    return Promise.reject(new Error("Legacy elicitation is unavailable."));
  }
  return Promise.resolve(Reflect.apply(method, server, [params])).then((response: unknown) => {
    if (
      typeof response !== "object" ||
      response === null ||
      !("action" in response) ||
      typeof response.action !== "string"
    ) {
      throw new Error("Legacy elicitation returned an invalid response.");
    }
    return { action: response.action };
  });
}

describe("ClientCredentialsExtensionSupport", () => {
  it("retains an initialize capability after a cached negative metadata probe", async () => {
    const serverConfig = ServerConfigSchema.parse({
      id: "machine",
      transport: {
        kind: "http",
        url: "https://mcp.example.test/mcp",
        auth: {
          kind: "oauth",
          grant: "client_credentials",
          clientId: "machine-client",
          clientSecret: "env:OAUTH_SECRET",
          scopes: ["tools:read"],
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const extension = new ClientCredentialsExtensionSupport();
    try {
      const signal = new AbortController().signal;
      await extension.probe(serverConfig, signal, false);
      expect(extension.supported).toBe(false);
      extension.observe(true);
      await extension.probe(serverConfig, signal, false);
      expect(extension.supported).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores probe failures but preserves cancellation of the connection signal", async () => {
    const serverConfig = ServerConfigSchema.parse({
      id: "machine",
      transport: {
        kind: "http",
        url: "https://mcp.example.test/mcp",
        auth: {
          kind: "oauth",
          grant: "client_credentials",
          clientId: "machine-client",
          clientSecret: "env:OAUTH_SECRET",
          scopes: ["tools:read"],
        },
      },
    });
    const extension = new ClientCredentialsExtensionSupport();
    const signal = new AbortController().signal;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("transient network failure")));
    try {
      await expect(extension.probe(serverConfig, signal, false)).resolves.toBeUndefined();
      await expect(extension.probe(serverConfig, signal, false)).resolves.toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    try {
      await expect(extension.probe(serverConfig, controller.signal, false)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

interface MemoryPeer {
  readonly client: InMemoryTransport;
  readonly serverTransport: InMemoryTransport;
  readonly server: McpServer;
}

type MemoryCallHandler = (
  serverTransport: InMemoryTransport,
  params: CallToolRequest["params"],
  server: McpServer,
) => Promise<CallToolResult> | CallToolResult;

async function createMemoryPeer(
  options: {
    readonly count?: number;
    readonly modern?: boolean;
    readonly supportsApps?: boolean;
    readonly onCall?: MemoryCallHandler;
    readonly tools?: Tool[];
  } = {},
): Promise<MemoryPeer> {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "memory-server", version: "1.0.0" });
  server.server.registerCapabilities({
    tools: { listChanged: true },
    ...(options.supportsApps === true ? { extensions: { "io.modelcontextprotocol/ui": {} } } : {}),
  });
  if (options.modern === true) {
    server.server.setRequestHandler("server/discover", () => ({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: true } },
    }));
  }
  const count = options.count ?? 2;
  const tools =
    options.tools ??
    Array.from({ length: count }, (_, index) => ({
      name: `tool-${String(index + 1)}`,
      inputSchema,
    }));
  server.server.setRequestHandler("tools/list", (request) => {
    if (count !== 2) {
      return { tools };
    }
    if (request.params?.cursor === "second") {
      return { tools: [tools[1] ?? { name: "fallback", inputSchema }] };
    }
    return { tools: [tools[0] ?? { name: "fallback", inputSchema }], nextCursor: "second" };
  });
  server.server.setRequestHandler("tools/call", (request) => {
    if (options.onCall !== undefined) {
      return options.onCall(serverTransport, request.params, server);
    }
    return { content: [{ type: "text", text: "called" }] };
  });
  await server.connect(serverTransport);
  return { client, serverTransport, server };
}

function config(
  options: {
    readonly protocol?: "auto" | "2026-07-28" | "2025-11-25";
    readonly idempotentTools?: string[];
    readonly connectMs?: number;
    readonly trust?: "internal" | "external";
    readonly propagateTrace?: boolean;
    readonly elicitation?: ServerConfig["elicitation"];
  } = {},
) {
  return ServerConfigSchema.parse({
    id: "mcp_test",
    transport: { kind: "stdio", command: "not-spawned-by-memory-transport" },
    protocol: options.protocol ?? "auto",
    trust: options.trust ?? "external",
    propagateTrace: options.propagateTrace ?? false,
    idempotentTools: options.idempotentTools,
    elicitation: options.elicitation,
    timeouts: { connectMs: options.connectMs ?? 1_000, callMs: 1_000 },
  });
}

function connectionFor(
  serverConfig = config(),
  createTransport: () => Promise<Transport>,
  sleep: (milliseconds: number) => Promise<void> = () => Promise.resolve(),
) {
  return new McpConnection(serverConfig, {
    resolveSecret: () => Promise.reject(new Error("unexpected secret reference")),
    createTransport: () => createTransport(),
    sleep,
  });
}

/** Forwards a peer transport but replaces every `tools/list` result's `tools` with a non-array. */
function corruptToolLists(peerTransport: Transport): Transport {
  const inner = peerTransport;
  const proxy: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
  };
  inner.onmessage = (message, extra) => {
    if ("result" in message && "tools" in message.result) {
      proxy.onmessage?.({ ...message, result: { ...message.result, tools: { tool: "x" } } }, extra);
      return;
    }
    proxy.onmessage?.(message, extra);
  };
  inner.onclose = () => {
    proxy.onclose?.();
  };
  inner.onerror = (error) => {
    proxy.onerror?.(error);
  };
  return proxy;
}

/** A legacy in-memory server that counts `tools/list` requests and can announce list changes. */
async function createCountingPeer(ttlMs?: number) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "counting-server", version: "1.0.0" });
  server.server.registerCapabilities({ tools: { listChanged: true } });
  let listRequests = 0;
  server.server.setRequestHandler("tools/list", () => {
    listRequests += 1;
    return {
      tools: [{ name: "counted", inputSchema }],
      ...(ttlMs === undefined ? {} : { ttlMs }),
    };
  });
  await server.connect(serverTransport);
  return {
    client,
    serverTransport,
    server,
    listRequests: () => listRequests,
  };
}

/** Resolves a transport only when released, so tests can act during the handshake. */
function deferredTransport(transport: Transport) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    create: async () => {
      await released;
      return transport;
    },
    release: () => {
      release();
    },
  };
}

describe("McpConnection", () => {
  it("handles legacy server-initiated elicitation only during the bound tool call", async () => {
    const peer = await createMemoryPeer({
      count: 1,
      onCall: async (_transport, _params, server) => {
        const response = await legacyElicitInput(server.server, {
          mode: "url",
          elicitationId: "live-url-id",
          message: "Confirm the action",
          url: "https://example.test/continue",
        });
        await server.server.notification({
          method: "notifications/elicitation/complete",
          params: { elicitationId: "unknown-id" },
        });
        await server.server.notification({
          method: "notifications/elicitation/complete",
          params: { elicitationId: "live-url-id" },
        });
        return { content: [{ type: "text", text: response.action }] };
      },
    });
    const connection = connectionFor(
      config({
        protocol: "2025-11-25",
        elicitation: {
          enabled: true,
          modes: ["url"],
          maxRounds: 2,
          maxPerRun: 4,
          maxRequestStateBytes: 128,
          legacyLiveTimeoutMs: 100,
        },
      }),
      () => Promise.resolve(peer.client),
    );
    const answers: string[] = [];
    const onComplete = vi.fn();
    try {
      await connection.connect();
      await connection.listTools();
      const result = await connection.callTool({
        params: { name: "tool-1", arguments: { value: "ok" } },
        inputSchema,
        options: { signal: new AbortController().signal },
        legacyElicitation: {
          signal: new AbortController().signal,
          handle: (request, elicitationId) => {
            answers.push(`${request.message}:${elicitationId}`);
            return Promise.resolve({ action: "accept", content: {} });
          },
          onComplete,
        },
      });
      expect(result.content).toEqual([{ type: "text", text: "accept" }]);
      expect(answers).toEqual(["Confirm the action:live-url-id"]);
      expect(onComplete).toHaveBeenCalledWith("live-url-id");
      await expect(
        legacyElicitInput(peer.server.server, {
          mode: "url",
          elicitationId: "outside-call",
          message: "Outside a tool call",
          url: "https://example.test/outside",
        }),
      ).resolves.toMatchObject({ action: "cancel" });
      expect(answers).toHaveLength(1);
    } finally {
      await connection.close();
      await peer.serverTransport.close();
    }
  });
  it.each([
    [new McpConnectionError("mcp_connection_lost"), true],
    [new McpConnectionError("mcp_connect_failed"), false],
    [{ code: "ECONNRESET" }, true],
    [{ code: "remote_failure" }, false],
    [new Error("remote failure"), false],
  ])("classifies safe connection-loss errors", (error, expected) => {
    expect(isConnectionLossError(error)).toBe(expected);
  });

  it("exports the MCP connection, pool, and transport APIs from the package entry point", () => {
    expect(Object.keys(mcpPackage).sort()).toEqual([
      "LegacyElicitationCompletionTracker",
      "McpAuthRequiredError",
      "McpConnection",
      "McpConnectionError",
      "McpOAuthProvider",
      "McpPool",
      "McpPoolError",
      "McpProtocolError",
      "McpToolPort",
      "OAuthCredentialRecordSchema",
      "OAuthTokenStore",
      "OAuthTokenStoreError",
      "ToolRegistry",
      "ToolRegistryError",
      "UNREGISTERED_TOOL_ID",
      "buildRequestMeta",
      "checkElicitationUrl",
      "createMcpTransport",
      "createServersAuthorizedCheck",
      "createServersReachableChecks",
      "handleLegacyLiveElicitation",
      "legacyUrlInputRequiredResult",
      "normalizeToolId",
      "startMcpOAuthLogin",
      "withOAuthWarningsRedacted",
    ]);
  });

  it("connects with auto protocol negotiation and lists every paginated tool", async () => {
    const peer = await createMemoryPeer({ modern: true });
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));

    await connection.connect();

    expect(connection.state).toBe("ready");
    expect(connection.protocolEra).toBe("legacy");
    await expect(connection.listTools()).resolves.toEqual([
      { name: "tool-1", inputSchema },
      { name: "tool-2", inputSchema },
    ]);
    await connection.close();
    await peer.serverTransport.close();
  });

  it("exposes negotiated protocol metadata and MCP Apps support", async () => {
    const peer = await createMemoryPeer({ supportsApps: true });
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));

    expect(connection.serverMetadata.protocolVersion).toBeUndefined();
    expect(connection.serverMetadata.supportsApps).toBe(false);
    await connection.connect();
    expect(connection.serverMetadata.protocolVersion).toBe("2025-11-25");
    expect(connection.serverMetadata.supportsApps).toBe(true);
    await connection.close();
    await peer.serverTransport.close();
  });

  it("uses legacy negotiation only when the protocol is explicitly pinned to 2025", async () => {
    const peer = await createMemoryPeer();
    const connection = connectionFor(config({ protocol: "2025-11-25" }), () =>
      Promise.resolve(peer.client),
    );

    await connection.connect();

    expect(connection.protocolEra).toBe("legacy");
    await connection.close();
    await peer.serverTransport.close();
  });

  it("rejects a modern-only pin when the peer negotiates only the legacy era", async () => {
    const peer = await createMemoryPeer();
    const connection = connectionFor(config({ protocol: "2026-07-28" }), () =>
      Promise.resolve(peer.client),
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "mcp_connect_failed" });
    await peer.serverTransport.close();
  });

  it("rejects a tool list that exceeds 1,000 entries", async () => {
    const peer = await createMemoryPeer({ count: 1_001 });
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));
    await connection.connect();

    await expect(connection.listTools()).rejects.toMatchObject({
      code: "mcp_too_many_tools",
    });
    await connection.close();
    await peer.serverTransport.close();
  });

  it("maps a stalled handshake to mcp_connect_timeout", async () => {
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const connection = connectionFor(config({ connectMs: 10 }), () => Promise.resolve(client));

    await expect(connection.connect()).rejects.toMatchObject({
      code: "mcp_connect_timeout",
    });
    expect(connection.state).toBe("unavailable");
    await serverTransport.close();
  });

  it("reconnects lazily after a transport closes using injected backoff", async () => {
    const peers: MemoryPeer[] = [];
    const delays: number[] = [];
    const connection = connectionFor(
      config(),
      async () => {
        const peer = await createMemoryPeer();
        peers.push(peer);
        return peer.client;
      },
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    );
    await connection.connect();

    const oldPeer = peers.at(0);
    if (oldPeer === undefined) {
      throw new Error("missing first in-memory server");
    }
    await oldPeer.serverTransport.close();
    expect(connection.state).toBe("unavailable");

    await expect(
      connection.callTool({ params: { name: "tool-1", arguments: { value: "ok" } }, inputSchema }),
    ).resolves.toMatchObject({ content: [{ text: "called" }] });
    expect(connection.state).toBe("ready");
    expect(delays).toEqual([250]);
    expect(peers).toHaveLength(2);
    for (const peer of peers) {
      await peer.serverTransport.close();
    }
    await connection.close();
  });

  it("retries a broken in-flight request only for configured idempotent tools", async () => {
    let calls = 0;
    const peers: MemoryPeer[] = [];
    const connection = connectionFor(
      config({ idempotentTools: ["tool-1"] }),
      async () => {
        const peer = await createMemoryPeer({
          onCall: async (serverTransport) => {
            calls += 1;
            if (calls === 1) {
              await serverTransport.close();
              return { content: [{ type: "text", text: "lost" }] };
            }
            return { content: [{ type: "text", text: "retried" }] };
          },
        });
        peers.push(peer);
        return peer.client;
      },
      () => Promise.resolve(),
    );
    await connection.connect();

    await expect(
      connection.callTool({ params: { name: "tool-1", arguments: { value: "ok" } }, inputSchema }),
    ).resolves.toMatchObject({ content: [{ text: "retried" }] });
    expect(calls).toBe(2);
    for (const peer of peers) {
      await peer.serverTransport.close();
    }
    await connection.close();
  });

  it("does not retry a broken in-flight request for non-idempotent tools", async () => {
    let calls = 0;
    const peers: MemoryPeer[] = [];
    const connection = connectionFor(config(), async () => {
      const peer = await createMemoryPeer({
        onCall: async (serverTransport) => {
          calls += 1;
          await serverTransport.close();
          return { content: [{ type: "text", text: "lost" }] };
        },
      });
      peers.push(peer);
      return peer.client;
    });
    await connection.connect();

    await expect(
      connection.callTool({ params: { name: "tool-1", arguments: { value: "ok" } }, inputSchema }),
    ).rejects.toMatchObject({ code: "mcp_connection_lost" });
    expect(calls).toBe(1);
    await connection.close();
  });

  it("validates arguments before creating a transport", async () => {
    const createTransport = vi.fn(() => Promise.reject(new Error("transport must not be created")));
    const connection = connectionFor(config(), createTransport);

    await expect(
      connection.callTool({ params: { name: "tool-1", arguments: {} }, inputSchema }),
    ).rejects.toMatchObject({ code: "mcp_tool_arguments_invalid" });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("maps transport failures to closed connection error codes", async () => {
    const connection = connectionFor(config(), () =>
      Promise.reject(new Error("server text must not escape")),
    );

    await expect(connection.connect()).rejects.toBeInstanceOf(McpConnectionError);
    await expect(connection.connect()).rejects.toMatchObject({ code: "mcp_connect_failed" });
  });

  it("uses all three bounded reconnect delays before reporting an unavailable server", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const connection = connectionFor(
      config(),
      () => {
        attempts += 1;
        return Promise.reject(new Error("server failure"));
      },
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    );

    await expect(connection.listTools()).rejects.toMatchObject({ code: "mcp_connect_failed" });
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 1_000, 4_000]);
  });

  it("stops reconnecting when the caller aborts during backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const connection = connectionFor(
      config(),
      () => {
        attempts += 1;
        return Promise.reject(new Error("must not connect after abort"));
      },
      () => {
        controller.abort();
        return Promise.resolve();
      },
    );

    await expect(
      connection.callTool({
        params: { name: "tool-1", arguments: { value: "ok" } },
        inputSchema,
        options: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "mcp_connect_timeout" });
    expect(attempts).toBe(0);
  });

  it("maps a tool protocol failure without forwarding remote error text", async () => {
    const peer = await createMemoryPeer({
      onCall: () => Promise.reject(new Error("remote failure text")),
    });
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));
    await connection.connect();

    await expect(
      connection.callTool({ params: { name: "tool-1", arguments: { value: "ok" } }, inputSchema }),
    ).rejects.toMatchObject({ code: "mcp_protocol_error", protocolCode: -32603 });
    expect(connection.state).toBe("ready");
    await connection.close();
    await peer.serverTransport.close();
  });

  it("sends trace context and existing metadata only to opted-in internal servers", async () => {
    const receivedMeta: (Record<string, unknown> | undefined)[] = [];
    const peer = await createMemoryPeer({
      onCall: (_transport, params) => {
        receivedMeta.push(params._meta);
        return { content: [{ type: "text", text: "called" }] };
      },
    });
    const trustedConnection = connectionFor(
      config({ trust: "internal", propagateTrace: true }),
      () => Promise.resolve(peer.client),
    );

    try {
      await trace.getTracer("mcp-test").startActiveSpan("harness.mcp_call", async (span) => {
        await trustedConnection.callTool({
          params: {
            name: "tool-1",
            arguments: { value: "ok" },
            _meta: {
              progressToken: "progress-1",
              traceparent: "00-stale",
              tracestate: "stale=value",
              baggage: "private=value",
            },
          },
          inputSchema,
        });
        expect(receivedMeta).toEqual([
          {
            progressToken: "progress-1",
            traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
          },
        ]);
      });
    } finally {
      await trustedConnection.close();
      await peer.serverTransport.close();
    }
  });

  it("does not send trace keys to an external server even if present in request metadata", async () => {
    const receivedMeta: (Record<string, unknown> | undefined)[] = [];
    const peer = await createMemoryPeer({
      onCall: (_transport, params) => {
        receivedMeta.push(params._meta);
        return { content: [{ type: "text", text: "called" }] };
      },
    });
    const connection = connectionFor(config(), () => Promise.resolve(peer.client));

    try {
      await connection.connect();
      await connection.callTool({
        params: {
          name: "tool-1",
          arguments: { value: "ok" },
          _meta: {
            progressToken: "progress-1",
            traceparent: "00-stale",
            tracestate: "stale=value",
            baggage: "private=value",
          },
        },
        inputSchema,
      });
      expect(receivedMeta).toEqual([{ progressToken: "progress-1" }]);
    } finally {
      await connection.close();
      await peer.serverTransport.close();
    }
  });
  it("rejects a malformed tools/list page with a closed code", async () => {
    const peer = await createMemoryPeer();
    const connection = connectionFor(undefined, () =>
      Promise.resolve(corruptToolLists(peer.client)),
    );
    await connection.connect();

    await expect(connection.listTools()).rejects.toMatchObject({ code: "mcp_list_tools_failed" });
    await connection.close();
    await peer.serverTransport.close();
  });

  it("lists tools without writing server-provided text to the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const peer = await createMemoryPeer();
      const connection = connectionFor(undefined, () => Promise.resolve(peer.client));
      await connection.connect();
      await connection.listTools();
      await connection.close();
      await peer.serverTransport.close();
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("retains valid x-mcp-header tools and excludes reserved headers on modern Streamable HTTP", () => {
    const headerTool: Tool = {
      name: "attacker <script> text",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    };
    const reservedTool: Tool = {
      name: "reserved",
      inputSchema: {
        type: "object",
        properties: { trace: { type: "string", "x-mcp-header": "traceparent" } },
      },
    };
    const plainTool: Tool = { name: "plain", inputSchema };
    const tools = [headerTool, reservedTool, plainTool];

    expect(excludeHeaderDeclaringTools(tools, { era: "modern", transport: "http" })).toEqual({
      tools: [headerTool, plainTool],
      excluded: 1,
    });

    expect(excludeHeaderDeclaringTools(tools, { era: "legacy", transport: "http" })).toEqual({
      tools,
      excluded: 0,
    });
    expect(excludeHeaderDeclaringTools(tools, { era: "modern", transport: "stdio" })).toEqual({
      tools,
      excluded: 0,
    });
  });

  it("maps tokenized x-mcp-header arguments to the modern HTTP request headers", async () => {
    const headerSchema = {
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" } },
      required: ["region"],
    } satisfies Tool["inputSchema"];
    const headerTool: Tool = { name: "header-tool", inputSchema: headerSchema };
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "http-server", version: "1.0.0" },
          { supportedProtocolVersions: ["2026-07-28"] },
        );
        server.server.registerCapabilities({ tools: { listChanged: true } });
        server.server.setRequestHandler("tools/list", () => ({ tools: [headerTool] }));
        server.server.setRequestHandler("tools/call", () => ({
          content: [{ type: "text", text: "called" }],
        }));
        return server;
      },
      { legacy: "reject" },
    );
    const requestHeaders: Headers[] = [];
    const clientTransport = new StreamableHTTPClientTransport(new URL("https://localhost/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestHeaders.push(request.headers);
        return handler.fetch(request);
      },
    });
    const serverConfig = ServerConfigSchema.parse({
      id: "mcp_test",
      transport: { kind: "http", url: "https://localhost/mcp" },
      protocol: "2026-07-28",
    });
    const connection = connectionFor(serverConfig, () => Promise.resolve(clientTransport));

    try {
      await connection.connect();
      const [listedTool] = await connection.listTools();
      if (listedTool === undefined) {
        throw new Error("missing header tool");
      }
      await connection.callTool({
        params: { name: listedTool.name, arguments: { region: "<EMAIL_1>" } },
        inputSchema: headerSchema,
        toolDefinition: listedTool,
      });
      expect(requestHeaders.at(-1)?.get("Mcp-Param-Region")).toBe("<EMAIL_1>");
    } finally {
      await connection.close();
      await handler.close();
    }
  });

  it("excludes tools whose schemas are too deep to scan", () => {
    let nested: JsonValue = { type: "string" };
    for (let index = 0; index < 40; index++) {
      nested = { type: "object", properties: { child: nested } };
    }
    const deepTool: Tool = {
      name: "deep",
      inputSchema: { type: "object", properties: { root: nested } },
    };

    expect(excludeHeaderDeclaringTools([deepTool], { era: "modern", transport: "http" })).toEqual({
      tools: [],
      excluded: 1,
    });
  });
  it("shares one in-flight handshake between concurrent connect calls", async () => {
    const peer = await createMemoryPeer();
    const deferred = deferredTransport(peer.client);
    const create = vi.fn(deferred.create);
    const connection = connectionFor(undefined, create);

    const first = connection.connect();
    const second = connection.connect();
    expect(connection.state).toBe("connecting");
    deferred.release();
    await Promise.all([first, second]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(connection.state).toBe("ready");
    await connection.connect();
    expect(create).toHaveBeenCalledTimes(1);
    await connection.close();
    await peer.serverTransport.close();
  });

  it("does not become ready when closed while the transport is being created", async () => {
    const peer = await createMemoryPeer();
    const deferred = deferredTransport(peer.client);
    const connection = connectionFor(undefined, deferred.create);

    const connecting = connection.connect();
    const closing = connection.close();
    deferred.release();
    await Promise.allSettled([connecting]);
    await closing;

    expect(connection.state).toBe("unavailable");
    await expect(connection.connect()).rejects.toMatchObject({ code: "mcp_connect_failed" });
    await expect(connection.listTools()).rejects.toMatchObject({ code: "mcp_connection_lost" });
    await peer.serverTransport.close();
  });

  it("maps an already-aborted caller signal to mcp_connect_timeout", async () => {
    const peer = await createMemoryPeer();
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));

    await expect(connection.connect(AbortSignal.abort())).rejects.toMatchObject({
      code: "mcp_connect_timeout",
    });
    expect(connection.state).toBe("unavailable");
    await peer.serverTransport.close();
  });

  it("aborts the handshake when the caller aborts mid-connect", async () => {
    const peer = await createMemoryPeer();
    const deferred = deferredTransport(peer.client);
    const connection = connectionFor(undefined, deferred.create);
    const controller = new AbortController();

    const connecting = connection.connect(controller.signal);
    controller.abort();
    deferred.release();

    await expect(connecting).rejects.toMatchObject({ code: "mcp_connect_timeout" });
    await connection.close();
    await peer.serverTransport.close();
  });

  it("serves tools from cache within the server ttlMs and fetches again after it expires", async () => {
    const peer = await createCountingPeer(1_000);
    let now = 10_000;
    const connection = new McpConnection(config(), {
      resolveSecret: () => Promise.reject(new Error("unexpected secret reference")),
      createTransport: () => Promise.resolve(peer.client),
      now: () => now,
    });
    await connection.connect();

    await connection.listTools();
    await connection.listTools();
    expect(peer.listRequests()).toBe(1);
    now += 1_001;
    await connection.listTools();
    expect(peer.listRequests()).toBe(2);
    await connection.close();
    await peer.serverTransport.close();
  });

  it("refreshes the tool list when the server announces a change", async () => {
    const peer = await createCountingPeer(60_000);
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));
    await connection.connect();
    await connection.listTools();
    expect(peer.listRequests()).toBe(1);

    await peer.server.server.notification({ method: "notifications/tools/list_changed" });

    await vi.waitFor(() => {
      expect(peer.listRequests()).toBe(2);
    });
    await connection.close();
    await peer.serverTransport.close();
  });

  it("accepts boolean JSON Schemas when validating tool arguments", async () => {
    const peer = await createMemoryPeer();
    const connection = connectionFor(undefined, () => Promise.resolve(peer.client));
    await connection.connect();

    await expect(
      connection.callTool({
        params: { name: "tool-1", arguments: { value: "ok" } },
        inputSchema: true,
      }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "called" }] });
    await connection.close();
    await peer.serverTransport.close();
  });
});
