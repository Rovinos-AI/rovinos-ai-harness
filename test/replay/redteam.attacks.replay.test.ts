// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { McpToolPort } from "@rovinos/mcp";
import { PolicyEngine } from "@rovinos/policy";
import { Code, ServerConfigSchema } from "@rovinos/schemas";
import { expect, it } from "vitest";

const inputSchema = { type: "object", properties: {} } satisfies Tool["inputSchema"];
const lookAlikes = [
  { nativeName: "exec ", toolId: "sandbox.exec_" },
  { nativeName: "\u0435xec", toolId: "sandbox._xec" },
] as const;

it("rejects a wildcard-allowed MCP look-alike of a denied tool", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "redteam-look-alike", version: "1.0.0" });
  const executions: string[] = [];
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler("tools/list", () => ({
    tools: ["exec", ...lookAlikes.map(({ nativeName }) => nativeName)].map((name) => ({
      name,
      inputSchema,
    })),
  }));
  server.server.setRequestHandler("tools/call", (request) => {
    executions.push(request.params.name);
    return { content: [{ type: "text", text: "executed" }] };
  });
  await server.connect(serverTransport);

  const config = ServerConfigSchema.parse({
    id: "sandbox",
    toolPrefix: "sandbox",
    transport: { kind: "stdio", command: "not-spawned-by-test" },
    timeouts: { callMs: 1_000 },
  });
  const port = await McpToolPort.create([config], {
    resolveSecret: () => Promise.reject(new Error("unexpected secret")),
    createTransport: () => clientTransport,
  });

  try {
    const policy = new PolicyEngine({
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_exec",
          match: { tools: ["sandbox.exec"] },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "allow_sandbox",
          match: { tools: ["sandbox.*"] },
          decision: "allow",
          reason: "allowed",
        },
      ],
    });

    expect(port.getToolSpecs().map(({ toolId }) => toolId)).toEqual(["sandbox.exec"]);
    for (const { toolId } of lookAlikes) {
      const code = Code.parse(toolId);
      expect(policy.decide({ toolId: code, args: {} }, { subagent: false }).decision).toBe("allow");
      await expect(
        port.execute(
          {
            callId: "00000000000000000000000000",
            toolId: code,
            args: {},
          },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({ outcome: "error", errorCode: "mcp_tool_not_found" });
    }
    expect(executions).toEqual([]);
  } finally {
    await port.close();
    await serverTransport.close();
  }
});
