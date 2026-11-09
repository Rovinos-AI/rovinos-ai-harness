// SPDX-License-Identifier: Apache-2.0
import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const counterPath = process.argv[2];
if (counterPath === undefined) {
  throw new Error("The synthetic MCP counter path is missing.");
}

const server = new McpServer(
  { name: "sdk-mcp-onboarding-test", version: "1.0.0" },
  { supportedProtocolVersions: ["2026-07-28"] },
);
server.registerTool(
  "echo",
  { description: "Return the supplied synthetic value.", inputSchema: z.object({ value: z.string() }) },
  async ({ value }) => {
    await appendFile(counterPath, "echo\n", "utf8");
    return { content: [{ type: "text", text: value }] };
  },
);
server.registerTool(
  "unselected",
  { description: "A synthetic tool that should remain hidden.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: "unselected" }] }),
);
serveStdio(() => server);
