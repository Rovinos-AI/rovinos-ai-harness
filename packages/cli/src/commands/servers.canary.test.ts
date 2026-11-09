// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { HarnessConfigSchema } from "@rovinos/config";
import { parseJson, ServersCheckResultSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { createServersCommand } from "./servers.js";

const descriptionCanary = "servers-check-description-canary";
const schemaCanary = "servers-check-schema-canary";
const secretCanary = "servers-check-secret-canary";
const sensitiveUrlCanary = "servers-check-sensitive-url-canary";

describe("harness servers check privacy canary", () => {
  it("omits secrets, descriptions, schemas, and sensitive URLs from default reports", async () => {
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const peer = new McpServer({ name: "servers-check-canary", version: "1.0.0" });
    const inputSchema = {
      type: "object",
      properties: { value: { type: "string", description: schemaCanary } },
      additionalProperties: false,
    } as const;
    peer.server.registerCapabilities({ tools: {} });
    peer.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "safe", description: descriptionCanary, inputSchema }],
    }));
    let toolCalls = 0;
    peer.server.setRequestHandler("tools/call", () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: secretCanary }] };
    });
    await peer.connect(serverTransport);

    let stdout = "";
    let stderr = "";
    const context: CliContext = {
      loadConfig: () =>
        Promise.resolve(
          HarnessConfigSchema.parse({
            servers: [
              {
                id: "canary",
                transport: {
                  kind: "http",
                  url: `https://mcp.example.test/mcp?token=${sensitiveUrlCanary}`,
                  headers: { Authorization: "env:SERVERS_CHECK_CANARY" },
                },
              },
            ],
          }),
        ),
      out: createOutput({
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      }),
      secretResolver: {
        resolve(reference) {
          if (reference !== "env:SERVERS_CHECK_CANARY") {
            return Promise.reject(new Error("unexpected secret reference"));
          }
          return Promise.resolve({ reveal: () => secretCanary });
        },
      },
      clock: { now: () => 1 },
    };

    try {
      const exitCode = await main(["--json", "servers", "check"], context, [
        createServersCommand({ createTransport: () => Promise.resolve(client) }),
      ]);
      const result = parseJson(ServersCheckResultSchema, stdout.trim());

      expect(exitCode).toBe(0);
      expect(result.reportVersion).toBe(1);
      expect(toolCalls).toBe(0);
      for (const canary of [descriptionCanary, schemaCanary, secretCanary, sensitiveUrlCanary]) {
        expect(`${stdout}${stderr}`).not.toContain(canary);
      }
    } finally {
      await Promise.all([client.close(), serverTransport.close()]);
    }
  });
});
