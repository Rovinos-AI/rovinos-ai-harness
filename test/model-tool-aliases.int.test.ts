// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { McpToolPort } from "@rovinos/mcp";
import { AnthropicAdapter, OpenAIAdapter, OpenAICompatibleAdapter } from "@rovinos/models";
import { compilePolicy, PolicyDocumentSchema } from "@rovinos/policy";
import { JsonValue, ModelRequestSchema, parseJson, ServerConfigSchema } from "@rovinos/schemas";
import type { ModelRequest } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const requestId = "00000000000000000000000000";
const callId = "00000000000000000000000001";
const inputSchema = {
  type: "object",
  properties: {
    city: { type: "string", minLength: 1 },
    units: { type: "string", enum: ["celsius", "fahrenheit"] },
  },
  required: ["city", "units"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];

const OpenAIRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([z.string(), z.null()]).optional(),
      tool_calls: z.array(z.looseObject({ id: z.string() })).optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  tools: z.array(
    z.looseObject({
      function: z.looseObject({ name: z.string(), parameters: JsonValue }),
    }),
  ),
  tool_choice: z
    .union([z.string(), z.looseObject({ function: z.looseObject({ name: z.string() }) })])
    .optional(),
});

const AnthropicRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z
            .looseObject({
              type: z.string(),
              id: z.string().optional(),
              tool_use_id: z.string().optional(),
              content: z.string().optional(),
            })
            .catchall(JsonValue),
        ),
      ]),
    }),
  ),
  tools: z.array(z.looseObject({ name: z.string(), input_schema: JsonValue })),
  tool_choice: z.looseObject({ type: z.string(), name: z.string().optional() }).optional(),
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

function providerRequestAt(requests: readonly JsonValue[], index: number): JsonValue {
  const request = requests[index];
  if (request === undefined) {
    throw new Error("The provider request was not captured.");
  }
  return request;
}

const providerProfiles = [
  { id: "openai", kind: "openai", model: "gpt-4o-mini" },
  { id: "anthropic", kind: "anthropic", model: "claude-sonnet-5-5" },
  { id: "local-compatible", kind: "openai_compatible", model: "fixture-model" },
] as const;

function openAIResponse(model: string, providerAlias: string, firstRequest: boolean) {
  return {
    id: firstRequest ? "chatcmpl-fixture" : "chatcmpl-followup",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        finish_reason: firstRequest ? "tool_calls" : "stop",
        message: firstRequest
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_weather",
                  type: "function",
                  function: {
                    name: providerAlias,
                    arguments: '{"city":"Helsinki","units":"celsius"}',
                  },
                },
              ],
            }
          : { role: "assistant", content: "Sunny in Helsinki." },
      },
    ],
    ...(firstRequest ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}),
  };
}

function anthropicResponse(model: string, providerAlias: string, firstRequest: boolean) {
  return {
    id: firstRequest ? "msg_fixture" : "msg_followup",
    type: "message",
    role: "assistant",
    model,
    content: firstRequest
      ? [
          {
            type: "tool_use",
            id: "toolu_fixture",
            name: providerAlias,
            input: { city: "Helsinki", units: "celsius" },
          },
        ]
      : [{ type: "text", text: "Sunny in Helsinki." }],
    stop_reason: firstRequest ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: firstRequest
      ? { input_tokens: 2, output_tokens: 3 }
      : { input_tokens: 1, output_tokens: 1 },
  };
}

describe("provider-safe MCP tool aliases", () => {
  it.each(providerProfiles)(
    "round-trips the discovered MCP schema and tool history through $id",
    async (profile) => {
      const current = await fixture();
      try {
        const tools = current.port.getToolSpecs();
        const [tool] = tools;
        if (tool === undefined) {
          throw new Error("The MCP fixture did not register its tool.");
        }
        const request: ModelRequest = ModelRequestSchema.parse({
          requestId,
          model: { provider: profile.id, model: profile.model },
          messages: [{ role: "user", parts: [{ type: "text", text: "Forecast Helsinki." }] }],
          tools: [...tools],
          toolChoice: { forced: tool.toolId },
          maxOutputTokens: 32,
        });
        let providerAlias = "";
        let providerChoiceAlias = "";
        const providerRequests: JsonValue[] = [];
        let adapter: OpenAIAdapter | AnthropicAdapter | OpenAICompatibleAdapter;

        if (profile.kind === "openai" || profile.kind === "openai_compatible") {
          const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
            if (typeof init?.body !== "string") {
              throw new TypeError("Expected a serialized OpenAI-compatible request body.");
            }
            const wireValue = parseJson(JsonValue, init.body);
            providerRequests.push(wireValue);
            const wireRequest = parseJson(OpenAIRequestSchema, init.body);
            const firstRequest = providerRequests.length === 1;
            if (firstRequest) {
              providerAlias = wireRequest.tools[0]?.function.name ?? "";
              providerChoiceAlias =
                typeof wireRequest.tool_choice === "object"
                  ? wireRequest.tool_choice.function.name
                  : "";
            }
            return Promise.resolve(
              new Response(
                JSON.stringify(openAIResponse(profile.model, providerAlias, firstRequest)),
                { headers: { "content-type": "application/json" } },
              ),
            );
          };
          if (profile.kind === "openai") {
            adapter = new OpenAIAdapter({
              apiKey: { reveal: () => "synthetic-test-key" },
              baseURL: "https://provider.test/v1",
              fetch,
            });
          } else {
            adapter = new OpenAICompatibleAdapter({
              provider: profile.id,
              apiKey: { reveal: () => "synthetic-test-key" },
              baseURL: "http://localhost:11434/v1",
              trust: "local",
              fetch,
            });
          }
        } else {
          adapter = new AnthropicAdapter({
            provider: profile.id,
            apiKey: { reveal: () => "synthetic-test-key" },
            baseURL: "https://provider.test",
            fetch: (_input, init) => {
              if (typeof init?.body !== "string") {
                throw new TypeError("Expected a serialized Anthropic request body.");
              }
              providerRequests.push(parseJson(JsonValue, init.body));
              const wireRequest = parseJson(AnthropicRequestSchema, init.body);
              providerAlias = wireRequest.tools[0]?.name ?? "";
              providerChoiceAlias = wireRequest.tool_choice?.name ?? "";
              const firstRequest = providerRequests.length === 1;
              return Promise.resolve(
                new Response(
                  JSON.stringify(anthropicResponse(profile.model, providerAlias, firstRequest)),
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
        const forwardedSchema =
          profile.kind === "anthropic"
            ? AnthropicRequestSchema.parse(providerRequestAt(providerRequests, 0)).tools[0]
                ?.input_schema
            : OpenAIRequestSchema.parse(providerRequestAt(providerRequests, 0)).tools[0]?.function
                .parameters;
        expect(forwardedSchema).toEqual(tool.inputSchema);
        expect(toolCall).toMatchObject({
          type: "tool_call",
          toolId: "weather.forecast",
          args: { city: "Helsinki", units: "celsius" },
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
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "text", text: "sunny" }],
          },
        });
        expect(current.executedArgs).toEqual([{ city: "Helsinki", units: "celsius" }]);
        expect(JSON.stringify({ policyToolId: toolCall.toolId, execution })).not.toContain(
          providerAlias,
        );

        const followupRequest = ModelRequestSchema.parse({
          ...request,
          toolChoice: "auto",
          messages: [
            ...request.messages,
            { role: "assistant", parts: result.parts },
            {
              role: "tool",
              parts: [
                {
                  type: "tool_result",
                  callId: toolCall.callId,
                  result: execution.result,
                  isError: execution.outcome === "error",
                },
              ],
            },
          ],
        });
        const followup = await adapter.complete(followupRequest, providerContext());
        expect(followup.parts).toContainEqual({ type: "text", text: "Sunny in Helsinki." });
        expect(followup.usage).toEqual(
          profile.kind === "anthropic"
            ? { inputTokens: 1, outputTokens: 1 }
            : { inputTokens: 0, outputTokens: 0 },
        );

        const serializedToolResult = JSON.stringify(execution.result);
        const historyChecks =
          profile.kind === "anthropic"
            ? (() => {
                const history = AnthropicRequestSchema.parse(
                  providerRequestAt(providerRequests, 1),
                ).messages;
                return {
                  hasAssistantToolCall: history.some(
                    (message) =>
                      message.role === "assistant" &&
                      typeof message.content !== "string" &&
                      message.content.some(
                        (block) => block.type === "tool_use" && block.id === "toolu_fixture",
                      ),
                  ),
                  hasMatchingToolResult: history.some(
                    (message) =>
                      message.role === "user" &&
                      typeof message.content !== "string" &&
                      message.content.some(
                        (block) =>
                          block.type === "tool_result" &&
                          block.tool_use_id === "toolu_fixture" &&
                          block.content === serializedToolResult,
                      ),
                  ),
                };
              })()
            : (() => {
                const history = OpenAIRequestSchema.parse(
                  providerRequestAt(providerRequests, 1),
                ).messages;
                return {
                  hasAssistantToolCall: history.some(
                    (message) =>
                      message.role === "assistant" &&
                      message.tool_calls?.some(
                        (providerTool) => providerTool.id === "call_weather",
                      ) === true,
                  ),
                  hasMatchingToolResult: history.some(
                    (message) =>
                      message.role === "tool" &&
                      message.tool_call_id === "call_weather" &&
                      message.content === serializedToolResult,
                  ),
                };
              })();
        expect(historyChecks.hasAssistantToolCall).toBe(true);
        expect(historyChecks.hasMatchingToolResult).toBe(true);
      } finally {
        await current.close();
      }
    },
  );
});
