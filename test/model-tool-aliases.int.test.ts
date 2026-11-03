// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { McpToolPort } from "@rovinos/mcp";
import { AnthropicAdapter, OpenAIAdapter } from "@rovinos/models";
import { compilePolicy, PolicyDocumentSchema } from "@rovinos/policy";
import { ModelRequestSchema, parseJson, ServerConfigSchema } from "@rovinos/schemas";
import type { ModelRequest } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const requestId = "00000000000000000000000000";
const callId = "00000000000000000000000001";
const inputSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];

const OpenAIRequestSchema = z.looseObject({
  tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string() }) })),
  tool_choice: z.looseObject({ function: z.looseObject({ name: z.string() }) }),
});

const AnthropicRequestSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  tool_choice: z.looseObject({ name: z.string() }),
});

async function fixture() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "weather-fixture", version: "1.0.0" });
  const executedArgs: unknown[] = [];
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "forecast", description: "Get a forecast", inputSchema }],
  }));
  server.server.setRequestHandler("tools/call", (request) => {
    executedArgs.push(request.params.arguments);
    return { content: [{ type: "text", text: "sunny" }] };
  });
  await server.connect(serverTransport);

  const port = await McpToolPort.create(
    [
      ServerConfigSchema.parse({
        id: "weather",
        toolPrefix: "weather",
        transport: { kind: "stdio", command: "not-spawned-by-test" },
        timeouts: { callMs: 1_000 },
        maxResultBytes: 1_048_576,
      }),
    ],
    {
      resolveSecret: () => Promise.reject(new Error("unexpected secret")),
      createTransport: () => clientTransport,
    },
  );
  return {
    port,
    executedArgs,
    close: async () => {
      await port.close();
      await serverTransport.close();
    },
  };
}

function providerContext() {
  return {
    signal: new AbortController().signal,
    ids: { next: () => callId },
    clock: { now: () => 1 },
  };
}

describe("provider-safe MCP tool aliases", () => {
  it.each(["openai", "anthropic"] as const)(
    "round-trips an advertised alias through %s and executes the canonical tool through policy",
    async (provider) => {
      const current = await fixture();
      try {
        const [tool] = current.port.getToolSpecs();
        if (tool === undefined) {
          throw new Error("The MCP fixture did not register its tool.");
        }
        const request: ModelRequest = ModelRequestSchema.parse({
          requestId,
          model: {
            provider,
            model: provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-5-5",
          },
          messages: [{ role: "user", parts: [{ type: "text", text: "Forecast Helsinki." }] }],
          tools: [...current.port.getToolSpecs()],
          toolChoice: { forced: tool.toolId },
          maxOutputTokens: 32,
        });
        let providerAlias = "";
        let providerChoiceAlias = "";
        let adapter: OpenAIAdapter | AnthropicAdapter;

        if (provider === "openai") {
          adapter = new OpenAIAdapter({
            apiKey: { reveal: () => "synthetic-test-key" },
            baseURL: "https://provider.test/v1",
            fetch: (_input, init) => {
              if (typeof init?.body !== "string") {
                throw new TypeError("Expected a serialized OpenAI request body.");
              }
              const wireRequest = parseJson(OpenAIRequestSchema, init.body);
              providerAlias = wireRequest.tools[0]?.function.name ?? "";
              providerChoiceAlias = wireRequest.tool_choice.function.name;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    id: "chatcmpl-fixture",
                    object: "chat.completion",
                    created: 1,
                    model: "gpt-4o-mini",
                    choices: [
                      {
                        index: 0,
                        finish_reason: "tool_calls",
                        message: {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "call_weather",
                              type: "function",
                              function: {
                                name: providerAlias,
                                arguments: '{"city":"Helsinki"}',
                              },
                            },
                          ],
                        },
                      },
                    ],
                    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              );
            },
          });
        } else {
          adapter = new AnthropicAdapter({
            apiKey: { reveal: () => "synthetic-test-key" },
            baseURL: "https://provider.test",
            fetch: (_input, init) => {
              if (typeof init?.body !== "string") {
                throw new TypeError("Expected a serialized Anthropic request body.");
              }
              const wireRequest = parseJson(AnthropicRequestSchema, init.body);
              providerAlias = wireRequest.tools[0]?.name ?? "";
              providerChoiceAlias = wireRequest.tool_choice.name;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    id: "msg_fixture",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-5-5",
                    content: [
                      {
                        type: "tool_use",
                        id: "toolu_fixture",
                        name: providerAlias,
                        input: { city: "Helsinki" },
                      },
                    ],
                    stop_reason: "tool_use",
                    stop_sequence: null,
                    usage: { input_tokens: 2, output_tokens: 3 },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              );
            },
          });
        }

        const result = await adapter.complete(request, providerContext());
        const toolCall = result.parts.find((part) => part.type === "tool_call");
        expect(providerAlias).toMatch(/^[\w-]{1,64}$/u);
        expect(providerAlias).not.toContain(".");
        expect(providerChoiceAlias).toBe(providerAlias);
        expect(toolCall).toMatchObject({
          type: "tool_call",
          toolId: "weather.forecast",
          args: { city: "Helsinki" },
        });
        if (toolCall?.type !== "tool_call") {
          throw new Error("The provider did not return a normalized tool call.");
        }

        const policy = compilePolicy(
          PolicyDocumentSchema.parse({
            version: 1,
            defaultDecision: "deny",
            rules: [
              {
                id: "weather.allow",
                match: { tools: ["weather.forecast"], context: { server: "weather" } },
                decision: "allow",
                reason: "weather_allowed",
              },
            ],
          }),
        );
        const decision = policy.evaluate({
          toolId: toolCall.toolId,
          args: toolCall.args,
          context: { subagent: false, server: "weather" },
        });
        expect(decision.decision).toBe("allow");

        const execution = await current.port.execute(
          { callId: toolCall.callId, toolId: toolCall.toolId, args: toolCall.args },
          { signal: new AbortController().signal },
        );
        expect(execution).toEqual({
          outcome: "ok",
          result: { content: [{ type: "text", text: "sunny" }] },
        });
        expect(current.executedArgs).toEqual([{ city: "Helsinki" }]);
        expect(JSON.stringify({ policyToolId: toolCall.toolId, execution })).not.toContain(
          providerAlias,
        );
      } finally {
        await current.close();
      }
    },
  );
});
