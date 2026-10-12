// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { ServerConfigSchema, type JsonValue } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { McpConnection, McpConnectionError, excludeHeaderDeclaringTools } from "./connection.js";
import * as mcpPackage from "./index.js";

const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];

interface MemoryPeer {
  readonly client: InMemoryTransport;
  readonly serverTransport: InMemoryTransport;
}

type MemoryCallHandler = (
  serverTransport: InMemoryTransport,
) => Promise<CallToolResult> | CallToolResult;

async function createMemoryPeer(
  options: {
    readonly count?: number;
    readonly modern?: boolean;
    readonly onCall?: MemoryCallHandler;
  } = {},
): Promise<MemoryPeer> {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "memory-server", version: "1.0.0" });
  server.server.registerCapabilities({ tools: { listChanged: true } });
  if (options.modern === true) {
    server.server.setRequestHandler("server/discover", () => ({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: true } },
    }));
  }
  const count = options.count ?? 2;
  const tools = Array.from({ length: count }, (_, index) => ({
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
  server.server.setRequestHandler("tools/call", () => {
    if (options.onCall !== undefined) {
      return options.onCall(serverTransport);
    }
    return { content: [{ type: "text", text: "called" }] };
  });
  await server.connect(serverTransport);
  return { client, serverTransport };
}

function config(
  options: {
    readonly protocol?: "auto" | "2026-07-28" | "2025-11-25";
    readonly idempotentTools?: string[];
    readonly connectMs?: number;
  } = {},
) {
  return ServerConfigSchema.parse({
    id: "mcp_test",
    transport: { kind: "stdio", command: "not-spawned-by-memory-transport" },
    protocol: options.protocol ?? "auto",
    idempotentTools: options.idempotentTools,
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
function corruptToolLists(inner: Transport): Transport {
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

describe("McpConnection", () => {
  it("exports the MCP connection, pool, and transport APIs from the package entry point", () => {
    expect(Object.keys(mcpPackage).sort()).toEqual([
      "McpConnection",
      "McpConnectionError",
      "McpPool",
      "McpPoolError",
      "createMcpTransport",
      "createServersReachableChecks",
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
      connection.callTool({ name: "tool-1", arguments: { value: "ok" } }, inputSchema),
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
      connection.callTool({ name: "tool-1", arguments: { value: "ok" } }, inputSchema),
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
      connection.callTool({ name: "tool-1", arguments: { value: "ok" } }, inputSchema),
    ).rejects.toMatchObject({ code: "mcp_connection_lost" });
    expect(calls).toBe(1);
    await connection.close();
  });

  it("validates arguments before creating a transport", async () => {
    const createTransport = vi.fn(() => Promise.reject(new Error("transport must not be created")));
    const connection = connectionFor(config(), createTransport);

    await expect(
      connection.callTool({ name: "tool-1", arguments: {} }, inputSchema),
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
      connection.callTool({ name: "tool-1", arguments: { value: "ok" } }, inputSchema, {
        signal: controller.signal,
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
      connection.callTool({ name: "tool-1", arguments: { value: "ok" } }, inputSchema),
    ).rejects.toMatchObject({ code: "mcp_tool_call_failed" });
    expect(connection.state).toBe("ready");
    await connection.close();
    await peer.serverTransport.close();
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

  it("excludes x-mcp-header tools only on modern Streamable HTTP and reports a count", () => {
    const headerTool: Tool = {
      name: "attacker <script> text",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    };
    const plainTool: Tool = { name: "plain", inputSchema };
    const tools = [headerTool, plainTool];

    expect(excludeHeaderDeclaringTools(tools, { era: "modern", transport: "http" })).toEqual({
      tools: [plainTool],
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
});
