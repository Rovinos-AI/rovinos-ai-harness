// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { ServerConfigSchema } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { McpToolPort } from "./tool-port.js";

it("registers six healthy servers with at most four discoveries running at once", async () => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fourStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let active = 0;
  let maximum = 0;
  const peers = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: "synthetic", version: "1.0.0" });
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler("tools/list", async () => {
        active++;
        maximum = Math.max(maximum, active);
        if (active === 4) {
          started();
        }
        try {
          await gate;
          return { tools: [{ name: "echo", inputSchema: { type: "object" as const } }] };
        } finally {
          active--;
        }
      });
      await server.connect(transport);
      return {
        client,
        server,
        config: ServerConfigSchema.parse({
          id: `synthetic_${String(index)}`,
          transport: { kind: "stdio", command: "not-spawned" },
          protocol: "2025-11-25",
        }),
      };
    }),
  );
  const creating = McpToolPort.create(
    peers.map(({ config }) => config),
    {
      resolveSecret: () => Promise.reject(new Error("synthetic_unexpected_secret")),
      createTransport: (config) => {
        const peer = peers.find((item) => item.config.id === config.id);
        if (peer === undefined) {
          throw new Error("synthetic_missing_peer");
        }
        return peer.client;
      },
      sleep: () => Promise.resolve(),
    },
  );
  try {
    await fourStarted;
    expect(active).toBe(4);
    release();
    const port = await creating;
    try {
      expect(port.getToolSpecs().map(({ toolId }) => toolId)).toEqual(
        peers.map(({ config }) => `${config.id}.echo`),
      );
      expect(maximum).toBe(4);
      expect(active).toBe(0);
    } finally {
      await port.close();
    }
  } finally {
    release();
    await Promise.all(peers.map(({ server }) => server.close()));
  }
});
