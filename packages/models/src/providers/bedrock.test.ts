// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { JsonValue, parseJson } from "@harness/schemas";
import type { ModelRequest } from "@harness/schemas";
import { fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import { ProviderError } from "../errors.js";
import { ProviderResultSchema } from "../types.js";
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
      name: "lookup",
      input: { query: "x" },
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

function createRequestHandler(
  fetcher: typeof undiciFetch,
  baseUrl: string,
  onPath?: (path: string) => void,
): NonNullable<BedrockAdapterOptions["requestHandler"]> {
  return {
    async handle(request, options) {
      onPath?.(request.path);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        }
      }
      const body =
        typeof request.body === "string"
          ? request.body
          : request.body instanceof Uint8Array
            ? new TextDecoder().decode(request.body)
            : undefined;
      const response = await fetcher(new URL(request.path, baseUrl), {
        method: request.method,
        headers,
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
    destroy() {},
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
    capabilities,
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
              name: "lookup",
              description: "Find a record",
              inputSchema: { json: baseRequest.tools?.[0]?.inputSchema },
            },
          },
        ],
        toolChoice: { tool: { name: "lookup" } },
      },
    });
    expect(call.getRequestPath()).toContain("amazon.nova-pro-v1");
  });

  it("maps automatic tool choice and omits tools when disabled", async () => {
    const automatic = makeCall({ ...responseBody, output: { message: { content: [{ text: "ok" }] } } });
    await automatic.adapter.complete(
      { ...baseRequest, toolChoice: "auto" },
      context(),
    );
    expect(automatic.getRequestBody()).toMatchObject({
      toolConfig: { toolChoice: { auto: {} } },
    });

    const disabled = makeCall({ ...responseBody, output: { message: { content: [{ text: "ok" }] } } });
    await disabled.adapter.complete({ ...baseRequest, toolChoice: "none" }, context());
    expect(disabled.getRequestBody()).not.toHaveProperty("toolConfig");
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
    [503, "InternalServerException", "provider_unavailable", 503],
    [503, "ModelNotReadyException", "provider_unavailable", 503],
    [408, "ModelTimeoutException", "provider_timeout", 408],
    [404, "ResourceNotFoundException", "provider_bad_request", 404],
  ] as const)("maps %s %s without retrying", async (status, name, code, mappedStatus) => {
    const call = makeCall(
      { message: "synthetic provider failure", __type: name },
      status,
      { "x-amzn-errortype": name },
    );
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code,
      ...(mappedStatus === undefined ? {} : { status: mappedStatus }),
    });
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
        Promise.resolve({ accessKeyId: "synthetic-access-key", secretAccessKey: "synthetic-secret" }),
    });
    const error = await adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "provider_unknown", message: "provider_unknown" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("status");
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
