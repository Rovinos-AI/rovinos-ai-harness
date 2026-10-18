// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { ModelErrorException } from "@aws-sdk/client-bedrock-runtime";
import { JsonValue, parseJson } from "@harness/schemas";
import type { JsonValue as JsonValueType, ModelRequest } from "@harness/schemas";
import { Headers, Response, type fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import { ProviderError } from "../errors.js";
import { ModelGateway } from "../gateway.js";
import { AdapterRegistry } from "../registry.js";
import { ProviderResultSchema } from "../types.js";
import { mapBedrockError } from "./bedrock-errors.js";
import type { BedrockAdapterOptions } from "./bedrock.js";
import { BedrockAdapter } from "./bedrock.js";

const requestId = "00000000000000000000000000";
const toolCallId = "00000000000000000000000001";
const rawContent = [
  {
    reasoningContent: {
      reasoningText: { text: "synthetic reasoning", signature: "synthetic-signature" },
    },
  },
  {
    reasoningContent: { redactedContent: "AQID" },
  },
  { text: "answer" },
  {
    toolUse: {
      toolUseId: "tooluse_fixture",
      name: "h0",
      input: { query: "x", image: { bytes: "AQID" } },
    },
  },
];
const responseBody = {
  output: { message: { role: "assistant", content: rawContent } },
  stopReason: "tool_use",
  usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
};
const baseRequest: ModelRequest = {
  requestId,
  model: { provider: "bedrock", model: "test-model" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
  tools: [
    {
      toolId: "lookup",
      description: "Find a record",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
  toolChoice: { forced: "lookup" },
  maxOutputTokens: 32,
};
const fixtures = parseJson(
  z.array(ProviderContractFixtureSchema),
  readFileSync(new URL("./__fixtures__/bedrock/contract.json", import.meta.url), "utf8"),
);

interface MockBedrockRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface MockBedrockHandlerOptions {
  readonly abortSignal?: AbortSignal;
}

function readRequestBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return undefined;
}

function createRequestHandler(
  fetcher: typeof undiciFetch,
  baseUrl: string,
  onPath?: (path: string) => void,
): NonNullable<BedrockAdapterOptions["requestHandler"]> {
  return {
    async handle(request: MockBedrockRequest, options?: MockBedrockHandlerOptions) {
      onPath?.(request.path);
      const body = readRequestBody(request.body);
      const response = await fetcher(new URL(request.path, baseUrl), {
        method: request.method,
        headers: new Headers(request.headers),
        ...(body === undefined ? {} : { body }),
        ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
      return {
        response: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          body: new Uint8Array(await response.arrayBuffer()),
        },
      };
    },
    destroy: () => undefined,
  };
}

function adapterFor(
  options: ProviderContractAdapterOptions,
  _fixture: ProviderContractFixture,
): BedrockAdapter {
  return new BedrockAdapter({
    region: "us-east-1",
    modelIds: { "test-model": "amazon.nova-pro-v1:0" },
    requestHandler: createRequestHandler(options.fetch, options.baseUrl),
    credentialsProvider: () =>
      Promise.resolve({ accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret" }),
  });
}

function makeCall(
  body: unknown = responseBody,
  status = 200,
  headers: Record<string, string> = {},
  capabilities?: BedrockAdapterOptions["capabilities"],
) {
  let requestBody: JsonValue | undefined;
  let requestCount = 0;
  let requestPath: string | undefined;
  const fetcher: ProviderContractAdapterOptions["fetch"] = (_input, init) => {
    requestCount += 1;
    if (typeof init?.body === "string") {
      requestBody = parseJson(JsonValue, init.body);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    modelIds: { "test-model": "amazon.nova-pro-v1:0" },
    ...(capabilities === undefined ? {} : { capabilities }),
    requestHandler: createRequestHandler(fetcher, "https://bedrock.test", (path) => {
      requestPath = path;
    }),
    credentialsProvider: () =>
      Promise.resolve({ accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret" }),
  });
  return {
    adapter,
    getRequestBody: () => requestBody,
    getRequestCount: () => requestCount,
    getRequestPath: () => requestPath,
  };
}

function context(signal = new AbortController().signal) {
  return {
    signal,
    ids: { next: () => toolCallId },
    clock: { now: () => 10 },
  };
}

runProviderContract("Amazon Bedrock Converse contract", adapterFor, fixtures);

describe("BedrockAdapter", () => {
  it("maps model configuration, system content, tools, and inference settings", async () => {
    const call = makeCall({
      output: { message: { role: "assistant", content: [{ text: "answer" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    await call.adapter.complete(
      {
        ...baseRequest,
        messages: [
          { role: "system", parts: [{ type: "text", text: "system rule" }] },
          { role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        maxOutputTokens: undefined,
        temperature: 0.2,
      },
      context(),
    );

    expect(call.getRequestBody()).toMatchObject({
      system: [{ text: "system rule" }],
      messages: [{ role: "user", content: [{ text: "hello" }] }],
      inferenceConfig: { maxTokens: 4_096, temperature: 0.2 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "h0",
              description: "Find a record",
              inputSchema: { json: baseRequest.tools?.[0]?.inputSchema },
            },
          },
        ],
        toolChoice: { tool: { name: "h0" } },
      },
    });
    expect(call.getRequestPath()).toContain("amazon.nova-pro-v1");
  });

  it("maps automatic tool choice and omits tools when disabled", async () => {
    const automatic = makeCall({
      ...responseBody,
      output: { message: { content: [{ text: "ok" }] } },
    });
    await automatic.adapter.complete({ ...baseRequest, toolChoice: "auto" }, context());
    expect(automatic.getRequestBody()).toMatchObject({
      toolConfig: { toolChoice: { auto: {} } },
    });

    const disabled = makeCall({
      ...responseBody,
      output: { message: { content: [{ text: "ok" }] } },
    });
    await disabled.adapter.complete({ ...baseRequest, toolChoice: "none" }, context());
    expect(disabled.getRequestBody()).not.toHaveProperty("toolConfig");
  });

  it("maps required tool choice to Bedrock's any choice", async () => {
    const call = makeCall({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await call.adapter.complete({ ...baseRequest, toolChoice: "required" }, context());
    expect(call.getRequestBody()).toMatchObject({ toolConfig: { toolChoice: { any: {} } } });
  });

  it("round-trips reasoning signatures, redacted bytes, and tool ids through JSON", async () => {
    const first = makeCall();
    const firstResult = await first.adapter.complete(baseRequest, context());
    const persistedResult = parseJson(ProviderResultSchema, JSON.stringify(firstResult));
    const call = persistedResult.parts.find((part) => part.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    if (call?.type !== "tool_call") {
      return;
    }
    const second = makeCall({
      output: { message: { role: "assistant", content: [{ text: "continued" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await second.adapter.complete(
      {
        ...baseRequest,
        tools: [
          {
            toolId: "additional",
            description: "Additional tool",
            inputSchema: { type: "object" },
          },
          ...(baseRequest.tools ?? []),
        ],
        messages: [
          ...baseRequest.messages,
          { role: "assistant", parts: persistedResult.parts },
          {
            role: "tool",
            parts: [
              { type: "tool_result", callId: call.callId, result: { found: true }, isError: false },
            ],
          },
        ],
      },
      context(),
    );
    expect(second.getRequestBody()).toMatchObject({
      toolConfig: {
        tools: [{ toolSpec: { name: "h1" } }, { toolSpec: { name: "h0" } }],
        toolChoice: { tool: { name: "h0" } },
      },
    });
    const sentMessages = z
      .object({
        messages: z.array(z.object({ role: z.string(), content: JsonValue })),
      })
      .parse(second.getRequestBody()).messages;
    const assistantMessage = sentMessages.find((message) => message.role === "assistant");
    expect(JSON.stringify(assistantMessage?.content)).toBe(JSON.stringify(rawContent));
    expect(sentMessages.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "tooluse_fixture",
            content: [{ json: { found: true } }],
            status: "success",
          },
        },
      ],
    });
  });

  it("maps dotted MCP tool IDs to unique Bedrock names and decodes responses", async () => {
    const tools = ["mcp.lookup", "mcp_2e_lookup", "h0"].map((toolId) => ({
      toolId,
      description: toolId,
      inputSchema: { type: "object" },
    }));
    const call = makeCall({
      output: {
        message: {
          content: [{ toolUse: { toolUseId: "tooluse_fixture", name: "h0", input: {} } }],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const result = await call.adapter.complete(
      { ...baseRequest, tools, toolChoice: { forced: "mcp.lookup" } },
      context(),
    );
    expect(call.getRequestBody()).toMatchObject({
      toolConfig: {
        tools: [
          { toolSpec: { name: "h0" } },
          { toolSpec: { name: "h1" } },
          { toolSpec: { name: "h2" } },
        ],
        toolChoice: { tool: { name: "h0" } },
      },
    });
    expect(result.parts).toContainEqual({
      type: "tool_call",
      callId: toolCallId,
      toolId: "mcp.lookup",
      args: {},
    });
  });

  it("sanitizes dotted tool-use IDs consistently between calls and results", async () => {
    const dottedCallId = "call.with:separators";
    const wireId = `toolu_${Buffer.from(`toolu_${dottedCallId}`, "utf8").toString("base64url")}`;
    const call = makeCall({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await call.adapter.complete(
      {
        ...baseRequest,
        messages: [
          {
            role: "assistant",
            parts: [{ type: "tool_call", callId: dottedCallId, toolId: "lookup", args: {} }],
          },
          {
            role: "tool",
            parts: [
              { type: "tool_result", callId: dottedCallId, result: { ok: true }, isError: false },
            ],
          },
        ],
      },
      context(),
    );
    const messages = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(call.getRequestBody()).messages;
    expect(messages[0]?.content).toEqual([
      { toolUse: { toolUseId: wireId, name: "h0", input: {} } },
    ]);
    expect(messages[1]?.content).toMatchObject([{ toolResult: { toolUseId: wireId } }]);
  });

  it("sanitizes provider tool-use IDs before storing and replaying tool results", async () => {
    const sanitizedId = `toolu_${Buffer.from("provider.id:1", "utf8").toString("base64url")}`;
    const first = makeCall({
      output: {
        message: {
          content: [{ toolUse: { toolUseId: "provider.id:1", name: "h0", input: { query: "x" } } }],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const firstResult = await first.adapter.complete(baseRequest, context());
    const opaque = firstResult.parts.find((part) => part.type === "opaque");
    expect(opaque?.type).toBe("opaque");
    if (opaque?.type !== "opaque") {
      return;
    }
    const savedContent = z
      .object({
        content: z.array(z.object({ toolUse: z.object({ toolUseId: z.string() }) })),
      })
      .parse(opaque.blob).content;
    expect(savedContent[0]?.toolUse.toolUseId).toBe(sanitizedId);
    expect(savedContent[0]?.toolUse.toolUseId).toMatch(/^[A-Za-z0-9_-]+$/u);
    const toolCall = firstResult.parts.find((part) => part.type === "tool_call");
    expect(toolCall?.type).toBe("tool_call");
    if (toolCall?.type !== "tool_call") {
      return;
    }
    const second = makeCall({
      output: { message: { content: [{ text: "done" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await second.adapter.complete(
      {
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          { role: "assistant", parts: firstResult.parts },
          {
            role: "tool",
            parts: [
              {
                type: "tool_result",
                callId: toolCall.callId,
                result: { ok: true },
                isError: false,
              },
            ],
          },
        ],
      },
      context(),
    );
    const messages = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(second.getRequestBody()).messages;
    expect(messages.at(-1)?.content).toMatchObject([{ toolResult: { toolUseId: sanitizedId } }]);
  });

  it.each([
    { result: [1, 2] as JsonValueType, serialized: "[1,2]" },
    { result: 5 as JsonValueType, serialized: "5" },
    { result: null, serialized: "null" },
  ])("serializes non-object JSON tool results as text", async ({ result, serialized }) => {
    const first = makeCall();
    const firstResult = await first.adapter.complete(baseRequest, context());
    const second = makeCall({
      output: { message: { content: [{ text: "continued" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await second.adapter.complete(
      {
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          { role: "assistant", parts: firstResult.parts },
          {
            role: "tool",
            parts: [{ type: "tool_result", callId: toolCallId, result, isError: false }],
          },
        ],
      },
      context(),
    );
    const messages = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(second.getRequestBody()).messages;
    expect(messages.at(-1)?.content).toMatchObject([
      { toolResult: { content: [{ text: serialized }] } },
    ]);
  });

  it("restores binary image blocks but leaves tool-input JSON untouched", async () => {
    const imageCall = makeCall({
      output: { message: { content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await imageCall.adapter.complete(
      {
        ...baseRequest,
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "opaque",
                provider: "bedrock",
                blob: {
                  content: [{ image: { format: "png", source: { bytes: "AQID" } } }],
                  toolUseIdByCallId: {},
                  toolIdByCallId: {},
                  wireNameByToolId: {},
                },
              },
            ],
          },
        ],
      },
      context(),
    );
    expect(imageCall.getRequestBody()).toMatchObject({
      messages: [{ content: [{ image: { format: "png", source: { bytes: "AQID" } } }] }],
    });

    const invalid = makeCall();
    const error = await invalid.adapter
      .complete(
        {
          ...baseRequest,
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "opaque",
                  provider: "bedrock",
                  blob: {
                    content: [{ image: { format: "png", source: { bytes: "not-base64%" } } }],
                  },
                },
              ],
            },
          ],
        },
        context(),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(invalid.getRequestCount()).toBe(0);
  });

  it("uses native JSON schema output when configured for the model", async () => {
    const call = makeCall(
      {
        output: { message: { role: "assistant", content: [{ text: '{"ok":true}' }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      200,
      {},
      { structuredOutput: "native" },
    );
    await call.adapter.complete(
      {
        ...baseRequest,
        tools: undefined,
        toolChoice: undefined,
        output: {
          name: "result",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
          schemaHash: "a".repeat(64),
        },
      },
      context(),
    );

    expect(call.getRequestBody()).toMatchObject({
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              name: "result",
              schema: JSON.stringify({
                type: "object",
                properties: { ok: { type: "boolean" } },
              }),
            },
          },
        },
      },
    });
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["content_filtered", "provider_content_filtered"],
    ["guardrail_intervened", "provider_content_filtered"],
    ["model_context_window_exceeded", "length"],
    ["unrecognized_stop", "other"],
  ] as const)("maps Bedrock stop reason %s", async (stopReason, finishReason) => {
    const call = makeCall({
      output: { message: { content: [{ text: "successful response" }] } },
      stopReason,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const result = await call.adapter.complete(baseRequest, context());
    expect(result.finishReason).toBe(finishReason);
    expect(result.parts).toContainEqual({ type: "text", text: "successful response" });
  });

  it("replays canonical structured output after Bedrock's synthetic tool call is stripped", async () => {
    const requests: JsonValue[] = [];
    const responses = [
      {
        output: {
          message: {
            role: "assistant",
            content: [
              { toolUse: { toolUseId: "structured-result", name: "h0", input: { ok: true } } },
            ],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      },
      {
        output: { message: { role: "assistant", content: [{ text: "continued" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      },
    ];
    const fetcher: ProviderContractAdapterOptions["fetch"] = (_input, init) => {
      if (typeof init?.body === "string") {
        requests.push(parseJson(JsonValue, init.body));
      }
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("No synthetic response remains.");
      }
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    };
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      modelIds: { "test-model": "amazon.nova-pro-v1:0" },
      requestHandler: createRequestHandler(fetcher, "https://bedrock.test"),
      credentialsProvider: () =>
        Promise.resolve({
          accessKeyId: "synthetic-access-key",
          secretAccessKey: "synthetic-secret",
        }),
    });

    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => toolCallId },
      clock: { now: () => 10 },
      enforcement: { maxRepairs: 0 },
    });
    const outputRequest = { ...baseRequest, tools: undefined, toolChoice: undefined };
    const first = await gateway.complete(outputRequest, {
      runId: requestId,
      signal: new AbortController().signal,
      outputSchema: z.object({ ok: z.boolean() }),
    });
    expect(first.parts).toEqual([{ type: "text", text: '{"ok":true}' }]);
    await gateway.complete(
      {
        ...outputRequest,
        messages: [...outputRequest.messages, { role: "assistant", parts: first.parts }],
      },
      { runId: requestId, signal: new AbortController().signal },
    );
    const secondMessages = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(requests[1]).messages;
    expect(secondMessages.at(-1)).toEqual({
      role: "assistant",
      content: [{ text: '{"ok":true}' }],
    });
    expect(JSON.stringify(requests[1])).not.toContain("emit_result");
  });

  it("accounts for cached input as part of the inclusive gateway input total", async () => {
    const call = makeCall({
      output: { message: { content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: {
        inputTokens: 7,
        cacheReadInputTokens: 5,
        cacheWriteInputTokens: 3,
        outputTokens: 2,
        totalTokens: 17,
      },
    });
    const gateway = new ModelGateway(new AdapterRegistry([call.adapter]), {
      ids: { next: () => toolCallId },
      clock: { now: () => 10 },
      pricing: {
        "bedrock/test-model": {
          inputMicrosPerMTok: 10_000_000,
          outputMicrosPerMTok: 40_000_000,
          cacheReadMicrosPerMTok: 20_000_000,
          cacheWriteMicrosPerMTok: 30_000_000,
        },
      },
    });
    const result = await gateway.complete(baseRequest, {
      runId: requestId,
      signal: new AbortController().signal,
    });
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      costMicros: 340,
    });
  });

  it("rejects missing Bedrock usage instead of silently reporting zero", async () => {
    const call = makeCall({
      output: { message: { content: [{ text: "answer" }] } },
      stopReason: "end_turn",
    });
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "provider_unknown" });
  });

  it("rejects an unconfigured model and a forced choice without its tool", async () => {
    const unknownModel = makeCall();
    const modelError = await unknownModel.adapter
      .complete({ ...baseRequest, model: { provider: "bedrock", model: "unknown" } }, context())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(modelError).toMatchObject({ code: "provider_bad_request" });
    expect(unknownModel.getRequestCount()).toBe(0);

    const unknownTool = makeCall();
    const toolError = await unknownTool.adapter
      .complete({ ...baseRequest, tools: [], toolChoice: { forced: "lookup" } }, context())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(toolError).toMatchObject({ code: "provider_bad_request" });
    expect(unknownTool.getRequestCount()).toBe(0);
  });

  it.each([
    [400, "ValidationException", "provider_bad_request", 400],
    [403, "AccessDeniedException", "provider_auth", 403],
    [429, "ThrottlingException", "provider_rate_limited", 429],
    [503, "ServiceUnavailableException", "provider_unavailable", 503],
    [500, "InternalServerException", "provider_unavailable", 500],
    [503, "ModelNotReadyException", "provider_unavailable", 503],
    [408, "ModelTimeoutException", "provider_timeout", 408],
    [404, "ResourceNotFoundException", "provider_bad_request", 404],
  ] as const)("maps %s %s without retrying", async (status, name, code, mappedStatus) => {
    const call = makeCall({ message: "synthetic provider failure", __type: name }, status, {
      "x-amzn-errortype": name,
    });
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status: mappedStatus });
    expect(call.getRequestCount()).toBe(1);
  });

  it("does not retain provider messages on unknown SDK failures", async () => {
    const fetcher: ProviderContractAdapterOptions["fetch"] = () =>
      Promise.reject(new Error("synthetic private detail"));
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      modelIds: { "test-model": "amazon.nova-pro-v1:0" },
      requestHandler: createRequestHandler(fetcher, "https://bedrock.test"),
      credentialsProvider: () =>
        Promise.resolve({
          accessKeyId: "synthetic-access-key",
          secretAccessKey: "synthetic-secret",
        }),
    });
    const error = await adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "provider_unknown", message: "provider_unknown" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("status");
  });

  it.each([
    {
      name: "ModelTimeoutException",
      status: 408,
      code: "provider_timeout",
      retryAfterMs: undefined,
    },
    {
      name: "ThrottlingException",
      status: 429,
      code: "provider_rate_limited",
      retryAfterMs: 2_000,
    },
    {
      name: "ServiceQuotaExceededException",
      status: 429,
      code: "provider_rate_limited",
      retryAfterMs: 2_000,
    },
    {
      name: "ModelStreamErrorException",
      status: 429,
      code: "provider_rate_limited",
      retryAfterMs: 2_000,
    },
    { name: "AccessDeniedException", status: 403, code: "provider_auth", retryAfterMs: undefined },
    {
      name: "ValidationException",
      status: 400,
      code: "provider_bad_request",
      retryAfterMs: undefined,
    },
    {
      name: "ResourceNotFoundException",
      status: 404,
      code: "provider_bad_request",
      retryAfterMs: undefined,
    },
    {
      name: "InternalServerException",
      status: 500,
      code: "provider_unavailable",
      retryAfterMs: undefined,
    },
    {
      name: "ServiceUnavailableException",
      status: 503,
      code: "provider_unavailable",
      retryAfterMs: undefined,
    },
    {
      name: "ModelNotReadyException",
      status: 503,
      code: "provider_unavailable",
      retryAfterMs: undefined,
    },
    {
      name: "ContentFilteredException",
      status: 400,
      code: "provider_content_filtered",
      retryAfterMs: undefined,
    },
    {
      name: "GuardrailIntervenedException",
      status: 400,
      code: "provider_content_filtered",
      retryAfterMs: undefined,
    },
  ])("maps $name using its exception name and metadata", ({ name, status, code, retryAfterMs }) => {
    const mapped = mapBedrockError(
      {
        name,
        $metadata: {
          httpStatusCode: status,
          httpHeaders: { "retry-after": "2" },
        },
      },
      new AbortController().signal,
    );
    expect(mapped).toMatchObject({ code, status });
    if (retryAfterMs === undefined) {
      expect(mapped).not.toHaveProperty("retryAfterMs");
    } else {
      expect(mapped).toHaveProperty("retryAfterMs", retryAfterMs);
    }
  });

  it("uses the original throttled status for a model-stream exception", () => {
    const mapped = mapBedrockError(
      {
        name: "ModelStreamErrorException",
        originalStatusCode: 429,
        $metadata: {
          httpStatusCode: 424,
          httpHeaders: { "retry-after": "1" },
        },
      },
      new AbortController().signal,
    );
    expect(mapped).toMatchObject({
      code: "provider_rate_limited",
      status: 429,
      retryAfterMs: 1_000,
    });
  });

  it("maps caller abort to a non-retryable cancellation without retrying send", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const fetcher: ProviderContractAdapterOptions["fetch"] = () => {
      requestCount += 1;
      controller.abort();
      return Promise.reject(new Error("Operation aborted."));
    };
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      modelIds: { "test-model": "amazon.nova-pro-v1:0" },
      requestHandler: createRequestHandler(fetcher, "https://bedrock.test"),
      credentialsProvider: () =>
        Promise.resolve({
          accessKeyId: "synthetic-access-key",
          secretAccessKey: "synthetic-secret",
        }),
    });
    const error = await adapter.complete(baseRequest, context(controller.signal)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "AbortError", message: "Operation aborted." });
    expect(error).not.toHaveProperty("retryable", true);
    expect(requestCount).toBe(1);
  });

  it("does not expose credential values in normalized errors or serialized requests", async () => {
    const credentials = [
      "synthetic-access-credential",
      "synthetic-secret-credential",
      "synthetic-session-credential",
    ];
    let sentRequest: string | undefined;
    const fetcher: ProviderContractAdapterOptions["fetch"] = (_input, init) => {
      sentRequest = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: credentials.join(" "),
            __type: "AccessDeniedException",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-amzn-errortype": "AccessDeniedException",
            },
          },
        ),
      );
    };
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      modelIds: { "test-model": "amazon.nova-pro-v1:0" },
      requestHandler: createRequestHandler(fetcher, "https://bedrock.test"),
      credentialsProvider: () =>
        Promise.resolve({
          accessKeyId: credentials[0] ?? "",
          secretAccessKey: credentials[1] ?? "",
          ...(credentials[2] === undefined ? {} : { sessionToken: credentials[2] }),
        }),
    });
    const error = await adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const serialized = `${String(error)}${JSON.stringify(error)}${sentRequest ?? ""}${JSON.stringify(baseRequest)}`;
    for (const credential of credentials) {
      expect(serialized).not.toContain(credential);
    }
  });

  it.each([
    [429, "provider_rate_limited", 429],
    [503, "provider_unavailable", 503],
    [400, "provider_bad_request", 400],
    [undefined, "provider_bad_request", undefined],
  ] as const)("maps model errors with original status %s", (status, code, mappedStatus) => {
    const error = new ModelErrorException({
      message: "synthetic model failure",
      $metadata: {},
      ...(status === undefined ? {} : { originalStatusCode: status }),
    });
    const mapped = mapBedrockError(error, new AbortController().signal);
    expect(mapped).toMatchObject({ code });
    if (mappedStatus === undefined) {
      expect(mapped).not.toHaveProperty("status");
    } else {
      expect(mapped).toHaveProperty("status", mappedStatus);
    }
  });

  it("rejects malformed opaque content without sending a request", async () => {
    const call = makeCall();
    const error = await call.adapter
      .complete(
        {
          ...baseRequest,
          messages: [
            { role: "assistant", parts: [{ type: "opaque", provider: "bedrock", blob: {} }] },
          ],
        },
        context(),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(call.getRequestCount()).toBe(0);
  });
});
