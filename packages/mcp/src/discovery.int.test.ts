// SPDX-License-Identifier: Apache-2.0
import { createServer, type ServerResponse } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseJson, ServerConfigSchema } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpConnection } from "./connection.js";

const RequestIdSchema = z.union([z.string(), z.number()]);
const RequestSchema = z.object({ id: RequestIdSchema.optional(), method: z.string() });
type RequestId = z.infer<typeof RequestIdSchema>;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

async function httpPeer(
  respond: (id: RequestId, response: ServerResponse) => void,
  protocol: "2026-07-28" | "2025-11-25" = "2026-07-28",
  callMs = 60_000,
) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "synthetic", version: "1.0.0" },
        { supportedProtocolVersions: [protocol] },
      );
      server.server.registerCapabilities({ tools: {} });
      return server;
    },
    { legacy: protocol === "2025-11-25" ? "stateless" : "reject" },
  );
  const http = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = parseJson(RequestSchema, text);
      response.setHeader("content-type", "application/json");
      respond(parsed.id ?? 0, response);
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("synthetic_listen_failed");
  }
  const url = `http://127.0.0.1:${String(address.port)}/mcp`;
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    await handler.close();
  });
  return {
    connect: async () => {
      const createTransport = () =>
        new StreamableHTTPClientTransport(new URL(url), {
          fetch: (input, init) => {
            const request = new Request(input, init);
            const payload =
              typeof init?.body === "string" ? parseJson(RequestSchema, init.body) : undefined;
            return payload?.method === "tools/list" ? fetch(input, init) : handler.fetch(request);
          },
        });
      const connection = new McpConnection(
        ServerConfigSchema.parse({
          id: "synthetic",
          transport: { kind: "http", url },
          protocol,
          timeouts: { callMs },
        }),
        {
          resolveSecret: () => Promise.reject(new Error("synthetic_unexpected_secret")),
          createTransport: () => Promise.resolve(createTransport()),
          sleep: () => Promise.resolve(),
        },
      );
      cleanups.push(() => connection.close());
      await connection.connect();
      return connection;
    },
  };
}

describe("HTTP discovery budgets", () => {
  it.each(["2026-07-28", "2025-11-25"] as const)(
    "cancels a dripping %s response body and never caches an incomplete result",
    async (protocol) => {
      let started: () => void = () => undefined;
      let closed: () => void = () => undefined;
      const bodyStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bodyClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      let calls = 0;
      const peer = await httpPeer((id, response) => {
        calls++;
        if (calls > 1) {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [] },
            }),
          );
          return;
        }
        response.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":`);
        const drip = setInterval(() => {
          response.write(" ");
        }, 5);
        response.on("close", () => {
          clearInterval(drip);
          closed();
        });
        started();
      }, protocol);
      const connection = await peer.connect();
      const controller = new AbortController();
      const result = connection.listTools(controller.signal).catch((error: unknown) => error);
      await bodyStarted;
      controller.abort(new Error("synthetic-sensitive-content"));
      expect(await result).toMatchObject({
        code: "mcp_discovery_cancelled",
        message: "mcp_discovery_cancelled",
      });
      await bodyClosed;
      await expect(connection.listTools()).resolves.toEqual([]);
      expect(calls).toBe(2);
    },
  );

  it.each(["2026-07-28", "2025-11-25"] as const)(
    "enforces the shared deadline on a slow %s HTTP body",
    async (protocol) => {
      let started: () => void = () => undefined;
      let closed: () => void = () => undefined;
      const bodyStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bodyClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const peer = await httpPeer((_id, response) => {
        response.write(" ");
        response.on("close", closed);
        started();
      }, protocol);
      const connection = await peer.connect();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = connection.listTools().catch((error: unknown) => error);
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ code: "mcp_discovery_timeout" });
      vi.useRealTimers();
      await bodyClosed;
    },
  );

  it.each(["2026-07-28", "2025-11-25"] as const)(
    "stops a %s body when callMs expires before the shared deadline",
    async (protocol) => {
      let started: () => void = () => undefined;
      let closed: () => void = () => undefined;
      const bodyStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const bodyClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const peer = await httpPeer(
        (_id, response) => {
          response.write(" ");
          response.on("close", closed);
          started();
        },
        protocol,
        500,
      );
      const connection = await peer.connect();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = connection.listTools().catch((error: unknown) => error);
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toMatchObject({ code: "mcp_list_tools_failed" });
      vi.useRealTimers();
      await bodyClosed;
      expect(connection.state).toBe(protocol === "2025-11-25" ? "unavailable" : "ready");
    },
  );

  it("bounds decoded data after the SDK buffers a large HTTP body", async () => {
    const peer = await httpPeer((id, response) => {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [
              {
                name: "synthetic",
                inputSchema: { type: "object" },
                description: "x".repeat(8_388_608),
              },
            ],
          },
        }),
      );
    });
    const connection = await peer.connect();
    await expect(connection.listTools()).rejects.toMatchObject({
      code: "mcp_discovery_data_limit",
      message: "mcp_discovery_data_limit",
    });
  });

  it("bounds concurrent servers and coalesces same-connection discoveries", async () => {
    const responses: { id: RequestId; response: ServerResponse }[] = [];
    let started: () => void = () => undefined;
    const fourStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const peer = await httpPeer((id, response) => {
      responses.push({ id, response });
      if (responses.length === 4) {
        started();
      }
    });
    const connections = await Promise.all(Array.from({ length: 6 }, () => peer.connect()));
    const first = connections[0];
    if (first === undefined) {
      throw new Error("synthetic_missing_connection");
    }
    const running = connections.map((connection) => connection.listTools());
    const coalesced = first.listTools();
    await fourStarted;
    expect(responses).toHaveLength(4);
    for (const { id, response } of responses) {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [] },
        }),
      );
    }
    await vi.waitFor(() => {
      expect(responses).toHaveLength(6);
    });
    for (const { id, response } of responses.slice(4)) {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [] },
        }),
      );
    }
    await expect(Promise.all([...running, coalesced])).resolves.toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it("aborts outstanding HTTP discovery when the connection closes", async () => {
    let started: () => void = () => undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const peer = await httpPeer((_id, response) => {
      response.write(" ");
      started();
    });
    const connection = await peer.connect();
    const result = connection.listTools().catch((error: unknown) => error);
    await bodyStarted;
    await connection.close();
    expect(await result).toMatchObject({ code: "mcp_discovery_cancelled" });
  });
});
