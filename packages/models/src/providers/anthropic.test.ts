// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { ClientOptions } from "@anthropic-ai/sdk";
import { JsonValue, parseJson } from "@harness/schemas";
import type { ModelRequest } from "@harness/schemas";
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
import { AnthropicAdapter } from "./anthropic.js";

const requestId = "00000000000000000000000000";
const toolSpec = {
  toolId: "lookup",
  description: "Find a record",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};
const baseRequest: ModelRequest = {
  requestId,
  model: { provider: "anthropic", model: "claude-sonnet-5-5" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
  tools: [toolSpec],
  toolChoice: { forced: "lookup" },
  maxOutputTokens: 32,
};
const rawContent = [
  { type: "thinking", thinking: "private reasoning", signature: "sig_fixture" },
  { type: "text", text: "answer" },
  { type: "tool_use", id: "toolu_fixture", name: "lookup", input: { query: "x" } },
];
const responseBody = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: rawContent,
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 11 },
};
const fixtures = parseJson(
  z.array(ProviderContractFixtureSchema),
  readFileSync(new URL("./__fixtures__/anthropic/contract.json", import.meta.url), "utf8"),
);

function adapterFor(
  fetch: ProviderContractAdapterOptions["fetch"],
  baseURL: string,
): AnthropicAdapter {
  const sdkFetch: NonNullable<ClientOptions["fetch"]> = async (input, init) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    const response = await fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined
        ? {}
        : { headers: Object.fromEntries(new Headers(init.headers)) }),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
  return new AnthropicAdapter({
    apiKey: { reveal: () => "synthetic-test-key" },
    fetch: sdkFetch,
    baseURL,
  });
}

function makeRequest(
  body: unknown = responseBody,
  status = 200,
  headers: Record<string, string> = {},
): {
  readonly adapter: AnthropicAdapter;
  readonly getRequestBody: () => JsonValue | undefined;
  readonly getRequestCount: () => number;
} {
  let requestBody: JsonValue | undefined;
  let requestCount = 0;
  const fetch: NonNullable<ClientOptions["fetch"]> = (_input, init) => {
    requestCount += 1;
    if (typeof init?.body === "string") {
      requestBody = JsonValue.parse(JSON.parse(init.body));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
  return {
    adapter: new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch,
      baseURL: "https://provider.test",
    }),
    getRequestBody: () => requestBody,
    getRequestCount: () => requestCount,
  };
}

function context(signal = new AbortController().signal) {
  let now = 0;
  return {
    signal,
    ids: { next: () => requestId },
    clock: {
      now: () => {
        now += 4;
        return now;
      },
    },
  };
}

function fixtureFactory(
  options: ProviderContractAdapterOptions,
  _fixture: ProviderContractFixture,
): AnthropicAdapter {
  return adapterFor(options.fetch, options.baseUrl);
}

runProviderContract("Anthropic Messages API contract", fixtureFactory, fixtures);

describe("AnthropicAdapter", () => {
  it.each([
    [500, "provider_unavailable"],
    [429, "provider_rate_limited"],
  ] as const)("does not retry HTTP %i", async (status, code) => {
    const call = makeRequest(
      { type: "error", error: { type: "api_error", message: "synthetic failure" } },
      status,
    );
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status });
    expect(call.getRequestCount()).toBe(1);
  });

  it("maps an invalid response tool name to a detail-free provider error", async () => {
    const call = makeRequest({
      ...responseBody,
      content: [{ type: "tool_use", id: "toolu_fixture", name: "get-Weather", input: {} }],
    });
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "provider_unknown", message: "provider_unknown" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("issues");
    expect(error).not.toHaveProperty("status");
  });

  it("merges adjacent same-role turns and preserves parallel tool-result order", async () => {
    const callIds = [requestId, "00000000000000000000000001"];
    const content = callIds.map((callId) => ({
      type: "tool_use",
      id: `toolu_${callId}`,
      name: "lookup",
      input: {},
    }));
    const call = makeRequest();
    await call.adapter.complete(
      {
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          { role: "user", parts: [{ type: "text", text: "also look up another record" }] },
          { role: "assistant", parts: [{ type: "text", text: "checking" }] },
          {
            role: "assistant",
            parts: [
              {
                type: "opaque",
                provider: "anthropic",
                blob: {
                  content,
                  toolUseIdByCallId: Object.fromEntries(
                    callIds.map((callId) => [callId, `toolu_${callId}`]),
                  ),
                },
              },
            ],
          },
          ...callIds.map((callId, index) => ({
            role: "tool" as const,
            parts: [
              {
                type: "tool_result" as const,
                callId,
                result: `result ${String(index)}`,
                isError: false,
              },
            ],
          })),
        ],
      },
      context(),
    );
    const body = z.object({ messages: JsonValue }).parse(call.getRequestBody());
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "also look up another record" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "checking" }, ...content] },
      {
        role: "user",
        content: callIds.map((callId, index) => ({
          type: "tool_result",
          tool_use_id: `toolu_${callId}`,
          content: `result ${String(index)}`,
          is_error: false,
        })),
      },
    ]);
  });

  it("round-trips thinking blocks, signatures, and Anthropic tool ids through JSON", async () => {
    const first = makeRequest();
    const firstResult = await first.adapter.complete(baseRequest, context());
    const persistedResult = parseJson(ProviderResultSchema, JSON.stringify(firstResult));
    const call = persistedResult.parts.find((part) => part.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    if (call?.type !== "tool_call") {
      return;
    }
    const nextRequest: ModelRequest = {
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
    };
    const second = makeRequest();
    await second.adapter.complete(nextRequest, context());
    const body = second.getRequestBody();
    expect(body).toBeDefined();
    const parsedBody = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(body);
    const assistantMessage = parsedBody.messages.find((message) => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    if (assistantMessage === undefined || !Array.isArray(assistantMessage.content)) {
      return;
    }
    expect(JSON.stringify(assistantMessage.content)).toBe(JSON.stringify(rawContent));
    const toolResult = parsedBody.messages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_result",
        ),
    );
    expect(toolResult).toBeDefined();
    if (toolResult === undefined || !Array.isArray(toolResult.content)) {
      return;
    }
    const resultBlock = toolResult.content.find(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result",
    );
    expect(resultBlock).toMatchObject({ tool_use_id: "toolu_fixture" });
  });

  it("uses the deterministic tool id when provider-specific history is absent", async () => {
    const callId = "00000000000000000000000001";
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        { role: "assistant", parts: [{ type: "tool_call", callId, toolId: "lookup", args: {} }] },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId, result: "done", isError: false }],
        },
      ],
    };
    const call = makeRequest();
    await call.adapter.complete(request, context());
    const body = z
      .object({ messages: z.array(z.object({ role: z.string(), content: JsonValue })) })
      .parse(call.getRequestBody());
    const assistantMessage = body.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toEqual([
      {
        type: "tool_use",
        id: `toolu_${callId}`,
        name: "lookup",
        input: {},
      },
    ]);
    const userMessage = body.messages.find((message) => message.role === "user");
    expect(userMessage?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: `toolu_${callId}`,
        content: "done",
        is_error: false,
      },
    ]);
  });

  it("maps system, forced tool, and toolChoice none request fields", async () => {
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        { role: "system", parts: [{ type: "text", text: "system rule" }] },
        { role: "user", parts: [{ type: "text", text: "hello" }] },
      ],
    };
    const call = makeRequest();
    await call.adapter.complete(request, context());
    const requestBody = z
      .object({
        system: JsonValue,
        tool_choice: JsonValue,
        tools: z.array(JsonValue),
      })
      .parse(call.getRequestBody());
    expect(requestBody.system).toEqual([{ type: "text", text: "system rule" }]);
    expect(requestBody.tool_choice).toEqual({ type: "tool", name: "lookup" });
    expect(requestBody.tools).toHaveLength(1);

    const noToolsRequest = { ...request, toolChoice: "none" as const };
    const noToolsCall = makeRequest();
    await noToolsCall.adapter.complete(noToolsRequest, context());
    const noToolsBody = z.record(z.string(), JsonValue).parse(noToolsCall.getRequestBody());
    expect(noToolsBody).not.toHaveProperty("tools");
    expect(noToolsBody).not.toHaveProperty("tool_choice");
  });

  it.each([
    [400, "provider_bad_request"],
    [403, "provider_auth"],
    [529, "provider_unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const call = makeRequest(
      { type: "error", error: { type: "api_error", message: "synthetic failure" } },
      status,
    );
    const error = await call.adapter.complete(baseRequest, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status });
  });

  it("maps supported stop reasons and uses a nonnegative injected latency", async () => {
    const request: ModelRequest = {
      ...baseRequest,
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    };
    const block = makeRequest({ ...responseBody, content: [], stop_reason: "refusal" });
    const result = await block.adapter.complete(request, context());
    expect(result.finishReason).toBe("other");
    expect(result.latencyMs).toBe(4);
    expect(result.parts).toEqual([
      {
        type: "opaque",
        provider: "anthropic",
        blob: { content: [], toolUseIdByCallId: {} },
      },
    ]);
    const stopSequence = makeRequest({
      ...responseBody,
      content: [],
      stop_reason: "stop_sequence",
    });
    const stopSequenceResult = await stopSequence.adapter.complete(request, context());
    expect(stopSequenceResult.finishReason).toBe("stop_sequence");
  });

  it("rejects a malformed matching opaque blob before sending a request", async () => {
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        { role: "assistant", parts: [{ type: "opaque", provider: "anthropic", blob: {} }] },
      ],
    };
    const call = makeRequest();
    const error = await call.adapter.complete(request, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(call.getRequestBody()).toBeUndefined();
  });

  it("rejects a request without the required Anthropic output-token limit", async () => {
    const request: ModelRequest = { ...baseRequest };
    delete request.maxOutputTokens;
    const call = makeRequest();
    const error = await call.adapter.complete(request, context()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "provider_bad_request" });
    expect(call.getRequestBody()).toBeUndefined();
  });
});
