// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { ServerConfigSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { McpPool, createServersReachableChecks } from "./pool.js";
import type { McpLogEvent } from "./transports.js";

function config(id: string) {
  return ServerConfigSchema.parse({
    id,
    transport: { kind: "stdio", command: "not-spawned-by-memory-transport" },
    protocol: "2025-11-25",
  });
}

async function createPeer() {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "pool-server", version: "1.0.0" });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
  await server.connect(serverTransport);
  return { client, serverTransport };
}

describe("McpPool", () => {
  it("connects all servers in parallel, retains state, and closes every connection", async () => {
    const peers: Awaited<ReturnType<typeof createPeer>>[] = [];
    const events: McpLogEvent[] = [];
    const pool = new McpPool([config("first"), config("second")], {
      resolveSecret: () => Promise.reject(new Error("no secrets expected")),
      createTransport: async () => {
        const peer = await createPeer();
        peers.push(peer);
        return peer.client;
      },
      logger: { log: (event) => events.push(event) },
    });

    await pool.connect();

    expect(pool.states()).toEqual([
      { serverId: "first", state: "ready", protocolEra: "legacy" },
      { serverId: "second", state: "ready", protocolEra: "legacy" },
    ]);
    expect(events).toEqual([]);
    await pool.close();
    expect(pool.states().map(({ state }) => state)).toEqual(["unavailable", "unavailable"]);
    for (const peer of peers) {
      await peer.serverTransport.close();
    }
  });

  it("tolerates connection failures and logs only a stable code", async () => {
    const events: McpLogEvent[] = [];
    const pool = new McpPool([config("offline")], {
      resolveSecret: () => Promise.reject(new Error("never resolved")),
      createTransport: () => Promise.reject(new Error("remote error text")),
      logger: { log: (event) => events.push(event) },
    });

    await expect(pool.connect()).resolves.toBeUndefined();

    expect(pool.states()).toEqual([{ serverId: "offline", state: "unavailable" }]);
    expect(events).toEqual([{ code: "mcp_connect_failed", serverId: "offline" }]);
    expect(JSON.stringify(events)).not.toContain("remote error text");
  });

  it("rejects unknown server lookups without including the requested id in its error", () => {
    const pool = new McpPool([], {
      resolveSecret: () => Promise.reject(new Error("not used")),
    });

    expect(() => pool.connection("unknown")).toThrowError("mcp_server_not_found");
  });

  it("creates per-server doctor results with only safe state and identifiers", async () => {
    const checks = createServersReachableChecks([config("reachable"), config("offline")], {
      resolveSecret: () => Promise.reject(new Error("not used")),
      createTransport: async (serverConfig) => {
        if (serverConfig.id === "offline") {
          throw new Error("secret server error");
        }
        const peer = await createPeer();
        return peer.client;
      },
    });

    expect(checks.map((check) => check.id)).toEqual([
      "servers_reachable.reachable",
      "servers_reachable.offline",
    ]);

    // Check ids remain stable regardless of server ordering
    const reorderedChecks = createServersReachableChecks([config("offline"), config("reachable")], {
      resolveSecret: () => Promise.reject(new Error("not used")),
    });
    expect(reorderedChecks.map((check) => check.id)).toEqual([
      "servers_reachable.offline",
      "servers_reachable.reachable",
    ]);

    await expect(Promise.all(checks.map((check) => check.run({})))).resolves.toEqual([
      { status: "ok", code: "servers_reachable", detail: "reachable" },
      { status: "fail", code: "mcp_connect_failed", detail: "offline" },
    ]);
  });

  it("reports an empty configured-server set as reachable", async () => {
    const [check] = createServersReachableChecks([], {
      resolveSecret: () => Promise.reject(new Error("not used")),
    });

    if (check === undefined) {
      throw new Error("missing empty server check");
    }
    await expect(check.run({})).resolves.toEqual({
      status: "ok",
      code: "servers_reachable",
    });
  });

  it("returns a safe timeout status when a doctor check is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const [check] = createServersReachableChecks([config("cancelled")], {
      resolveSecret: () => Promise.reject(new Error("not used")),
    });

    if (check === undefined) {
      throw new Error("missing configured server check");
    }
    await expect(check.run({ signal: controller.signal })).resolves.toEqual({
      status: "fail",
      code: "check_timeout",
      detail: "cancelled",
    });
  });
});
