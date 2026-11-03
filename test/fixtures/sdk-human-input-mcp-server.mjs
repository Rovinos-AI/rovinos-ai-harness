// SPDX-License-Identifier: Apache-2.0
import { appendFile } from "node:fs/promises";
import { McpServer, acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const counterPath = process.argv[2];
if (counterPath === undefined) {
  throw new Error("The synthetic MCP counter path is missing.");
}

const answerSchema = z.object({ email: z.email() }).strict();
const requestedSchema = {
  type: "object",
  properties: { email: { type: "string", format: "email" } },
  required: ["email"],
};
const server = new McpServer(
  { name: "sdk-human-input-test", version: "1.0.0" },
  { supportedProtocolVersions: ["2026-07-28"] },
);
server.server.registerCapabilities({ tools: {} });
server.registerTool(
  "confirm_action",
  { inputSchema: z.object({}).strict() },
  async (_args, context) => {
    const answer = acceptedContent(context.mcpReq.inputResponses, "account", answerSchema);
    if (answer === undefined) {
      return inputRequired({
        inputRequests: {
          account: inputRequired.elicit({
            message: "Provide the synthetic account email.",
            requestedSchema,
          }),
        },
        requestState: "synthetic-account-state",
      });
    }

    await appendFile(counterPath, "effect\n", "utf8");
    return {
      content: [{ type: "text", text: JSON.stringify({ completed: true }) }],
    };
  },
);
serveStdio(() => server);
