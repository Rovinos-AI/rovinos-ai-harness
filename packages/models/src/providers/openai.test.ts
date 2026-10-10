// SPDX-License-Identifier: Apache-2.0
import { JsonValue, ModelRequestSchema, parseJson } from "@harness/schemas";
import type { ModelRequest, Part } from "@harness/schemas";
import { MockAgent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runProviderContract, type ProviderContractFixture } from "../contract.js";
import { ProviderResultSchema } from "../types.js";
import { enforceToolOutput } from "../enforce/rung-tool.js";
import { OpenAIAdapter } from "./openai.js";
import { fromChatResponse, toChatRequest } from "./chat-completions-mapper.js";

const id = "00000000000000000000000000";
const rawToolMessage = {
  role: "assistant" as const,
  content: null,
  tool_calls: [
    {
      id: "call_openai_1",
      type: "function" as const,
      function: { name: "lookup", arguments: '{"key":"value"}' },
    },
  ],
};
const textMessage = { role: "assistant" as const, content: "answer" };
const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };

const request: ModelRequest = {
  requestId: id,
  model: { provider: "openai", model: "gpt-4o-mini" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};

function completion(message: JsonValue, finishReason = "stop") {
  return {
    id: "openai-result-fixture",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

function fixture(
  scenario: ProviderContractFixture["scenario"],
  status: number,
): ProviderContractFixture {
  const response = scenario === "tool_call" ? completion(rawToolMessage) : completion(textMessage);
  const expectedParts: Part[] =
    scenario === "tool_call"
      ? [
          { type: "tool_call", callId: id, toolId: "lookup", args: { key: "value" } },
          {
            type: "opaque",
            provider: "openai",
            blob: { message: rawToolMessage, openaiCallIdByCallId: { [id]: "call_openai_1" } },
          },
        ]
      : [
          { type: "text", text: "answer" },
          {
            type: "opaque",
            provider: "openai",
            blob: { message: textMessage, openaiCallIdByCallId: {} },
          },
        ];
  let expected: ProviderContractFixture["expected"];
  switch (scenario) {
    case "text_only":
    case "tool_call":
      expected = {
        parts: expectedParts,
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
      };
      break;
    case "usage_mapping":
      expected = { usage: { inputTokens: 2, outputTokens: 3 }, finishReason: "stop" };
      break;
    case "error_429":
      expected = { retryAfterMs: 2_000, status };
      break;
    case "error_500":
    case "error_401":
      expected = { status };
      break;
    case "abort_signal":
      expected = undefined;
      break;
  }

  return {
    scenario,
    request,
    httpResponse: {
      status,
      ...(scenario === "error_429" ? { headers: { "retry-after": "2" } } : {}),
      body:
        status === 200
          ? response
          : { error: { message: "fixture failure", type: "invalid_request_error" } },
    },
    ...(expected === undefined ? {} : { expected }),
  };
}

const contractFixtures = [
  fixture("text_only", 200),
  fixture("tool_call", 200),
  fixture("usage_mapping", 200),
  fixture("error_429", 429),
  fixture("error_500", 500),
  fixture("error_401", 401),
  fixture("abort_signal", 200),
];

function toUndiciRequestInit(init: RequestInit | undefined): UndiciRequestInit {
  const headers = new Headers(init?.headers);
  return {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: Object.fromEntries(headers.entries()) }),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
  };
}

async function toWebResponse(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<Response> {
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    headers.append(name, value);
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function adaptFetch(fetchRequest: typeof undiciFetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchRequest(
      input instanceof Request ? input.url : input.toString(),
      toUndiciRequestInit(init),
    );
    return toWebResponse(response);
  };
}

function mockFetch(dispatcher: MockAgent): typeof fetch {
  return async (input, init) => {
    const response = await undiciFetch(input instanceof Request ? input.url : input.toString(), {
      ...toUndiciRequestInit(init),
      dispatcher,
    });
    return toWebResponse(response);
  };
}

runProviderContract(
  "OpenAI Chat Completions contract",
  (options) =>
    new OpenAIAdapter({
      apiKey: { reveal: () => "test-key" },
      fetch: adaptFetch(options.fetch),
      baseURL: options.baseUrl,
    }),
  contractFixtures,
);

describe("OpenAI Chat Completions mapper", () => {
  it("round-trips provider call ids and raw assistant messages through JSON", () => {
    const response = fromChatResponse(
      {
        choices: [{ finish_reason: "tool_calls", message: rawToolMessage }],
        usage,
      },
      { next: () => id },
    );
    const nextRequest = ModelRequestSchema.parse({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", parts: response.parts },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: id, result: { found: true }, isError: false }],
        },
      ],
    });

    const serialized = JSON.stringify(nextRequest);
    const parsed = parseJson(ModelRequestSchema, serialized);
    const mapped = toChatRequest(parsed, {
      structuredOutput: "native",
      parallelToolCalls: true,
    });

    expect(mapped.messages[1]).toEqual(rawToolMessage);
    expect(mapped.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_openai_1",
      content: '{"found":true}',
    });
  });

  it("does not replay a forced synthetic tool call from opaque OpenAI messages", async () => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    const origin = "https://openai.test";
    const syntheticMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_emit",
          type: "function",
          function: { name: "emit_result", arguments: '{"answer":"ok"}' },
        },
        {
          id: "call_lookup",
          type: "function",
          function: { name: "lookup", arguments: '{"key":"value"}' },
        },
      ],
    };
    let secondRequest: JsonValue | undefined;
    const pool = dispatcher.get(origin);
    pool.intercept({ path: /.*/, method: "POST" }).reply(() => ({
      statusCode: 200,
      data: completion(syntheticMessage, "tool_calls"),
      responseOptions: { headers: { "content-type": "application/json" } },
    }));
    pool.intercept({ path: /.*/, method: "POST" }).reply((options) => {
      secondRequest = JsonValue.parse(JSON.parse(String(options.body)));
      return {
        statusCode: 200,
        data: completion(textMessage),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    });
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "test-key" },
      fetch: mockFetch(dispatcher),
      baseURL: origin,
    });
    const ids = [id, "00000000000000000000000001"];
    const providerResult = await adapter.complete(request, {
      signal: new AbortController().signal,
      ids: { next: () => ids.shift() ?? id },
      clock: { now: () => 0 },
    });
    const enforced = enforceToolOutput(
      providerResult.parts,
      z.object({ answer: z.string() }).strict(),
    );

    try {
      await adapter.complete(
        {
          ...request,
          messages: [
            ...request.messages,
            { role: "assistant", parts: enforced.parts },
            {
              role: "tool",
              parts: [
                {
                  type: "tool_result",
                  callId: "00000000000000000000000001",
                  result: { found: true },
                  isError: false,
                },
              ],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        },
      );

      expect(secondRequest).toBeDefined();
      expect(JSON.stringify(secondRequest)).not.toContain("emit_result");
      expect(secondRequest).toMatchObject({
        messages: [
          {},
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_lookup" }],
          },
          { role: "tool", tool_call_id: "call_lookup" },
        ],
      });
    } finally {
      await dispatcher.close();
    }
  });

  it.each([false, true])(
    "returns only an opaque recoverable result for invalid arguments (mixed: %s)",
    (mixed) => {
      const toolCalls = [
        {
          id: "call_broken",
          type: "function",
          function: { name: "lookup", arguments: "{invalid" },
        },
      ];
      if (mixed) {
        toolCalls.unshift(...rawToolMessage.tool_calls);
        toolCalls.push(...rawToolMessage.tool_calls);
      }
      const message = {
        role: "assistant" as const,
        content: "discard this text",
        tool_calls: toolCalls,
      };
      const result = fromChatResponse(
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message,
            },
          ],
        },
        { next: () => id },
      );
      const opaque = result.parts.find((part) => part.type === "opaque");

      expect(result.parts).toHaveLength(1);
      expect(result.finishReason).toBe("tool_args_invalid");
      expect(opaque).toMatchObject({
        type: "opaque",
        blob: { message },
      });
      expect(ProviderResultSchema.safeParse({ ...result, latencyMs: 0 }).success).toBe(true);
    },
  );

  it.each(["Invalid Name", "", "a".repeat(65)])(
    "returns a recoverable result for invalid tool name %j",
    (name) => {
      const message = {
        ...rawToolMessage,
        tool_calls: [
          ...rawToolMessage.tool_calls,
          {
            id: "call_invalid_name",
            type: "function",
            function: { name, arguments: "{}" },
          },
        ],
      };
      const result = fromChatResponse(
        { choices: [{ finish_reason: "tool_calls", message }] },
        { next: () => id },
      );

      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]).toMatchObject({ type: "opaque", blob: { message } });
      expect(result.finishReason).toBe("tool_args_invalid");
      expect(ProviderResultSchema.safeParse({ ...result, latencyMs: 0 }).success).toBe(true);
    },
  );

  it.each([
    { result: "done", content: "done" },
    { result: { found: true }, content: '{"found":true}' },
    { result: null, content: "null" },
    { result: 42, content: "42" },
    { result: false, content: "false" },
    { result: ["done"], content: '["done"]' },
  ])("maps tool result $result to $content", ({ result, content }) => {
    const mapped = toChatRequest(
      {
        ...request,
        messages: [
          {
            role: "tool",
            parts: [{ type: "tool_result", callId: id, result, isError: false }],
          },
        ],
      },
      { structuredOutput: "native", parallelToolCalls: true },
    );

    expect(mapped.messages).toEqual([{ role: "tool", tool_call_id: `call_${id}`, content }]);
  });

  it("maps multiple function calls, usage, and finish reasons", () => {
    const result = fromChatResponse(
      {
        choices: [
          {
            finish_reason: "content_filter",
            message: {
              role: "assistant",
              content: "answer",
              tool_calls: [
                {
                  id: "call_one",
                  type: "function",
                  function: { name: "one", arguments: '{"n":1}' },
                },
                {
                  id: "call_two",
                  type: "function",
                  function: { name: "two", arguments: '{"n":2}' },
                },
              ],
            },
          },
        ],
        usage,
      },
      { next: () => id },
    );

    expect(result.parts.filter((part) => part.type === "tool_call")).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(result.finishReason).toBe("provider_content_filtered");
  });

  it("sets tools, forced tool choice, token limit, and native output format", () => {
    const params = toChatRequest(
      {
        ...request,
        tools: [
          { toolId: "lookup", description: "Lookup a value", inputSchema: { type: "object" } },
        ],
        toolChoice: { forced: "lookup" },
        output: {
          name: "answer",
          schema: { type: "object", properties: { answer: { type: "string" } } },
          schemaHash: "a".repeat(64),
        },
        maxOutputTokens: 16,
      },
      { structuredOutput: "native", parallelToolCalls: true },
    );

    expect(params.max_completion_tokens).toBe(16);
    expect(params.parallel_tool_calls).toBe(true);
    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        strict: true,
      },
    });
    expect(params.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("uses provider ids as deterministic fallbacks and omits native format when unsupported", () => {
    const mapped = toChatRequest(
      {
        ...request,
        messages: [
          {
            role: "tool",
            parts: [{ type: "tool_result", callId: id, result: null, isError: true }],
          },
        ],
        toolChoice: "none",
        output: {
          name: "answer",
          schema: { type: "object" },
          schemaHash: "b".repeat(64),
        },
      },
      { structuredOutput: "none", parallelToolCalls: false },
    );

    expect(mapped.messages).toEqual([
      { role: "tool", tool_call_id: `call_${id}`, content: "null" },
    ]);
    expect(mapped.tools).toBeUndefined();
    expect(mapped.response_format).toBeUndefined();
  });

  it.each([
    {},
    { tools: [] },
    {
      tools: [{ toolId: "lookup", description: "Lookup a value", inputSchema: { type: "object" } }],
      toolChoice: "none" as const,
    },
  ])("omits parallel_tool_calls when tools are omitted: %j", (options) => {
    const mapped = toChatRequest(
      { ...request, ...options },
      { structuredOutput: "native", parallelToolCalls: true },
    );

    expect(mapped).not.toHaveProperty("tools");
    expect(mapped).not.toHaveProperty("parallel_tool_calls");
  });

  it("returns an empty normalized response when the provider returns no choices", () => {
    expect(fromChatResponse({ choices: [], usage }, { next: () => id })).toEqual({
      parts: [],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: "other",
    });
  });
});

describe("OpenAI adapter request behavior", () => {
  it.each([
    { status: 400, code: "provider_bad_request" },
    { status: 403, code: "provider_auth" },
    { status: 408, code: "provider_timeout" },
    { status: 404, code: "provider_unknown" },
  ])("maps HTTP $status to $code", async ({ status, code }) => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    const origin = "https://openai.test";
    dispatcher
      .get(origin)
      .intercept({ path: /.*/, method: "POST" })
      .reply(status, { error: { message: "fixture failure", type: "invalid_request_error" } });
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "test-key" },
      fetch: mockFetch(dispatcher),
      baseURL: origin,
    });

    try {
      await expect(
        adapter.complete(request, {
          signal: new AbortController().signal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        }),
      ).rejects.toMatchObject({ code, status });
    } finally {
      await dispatcher.close();
    }
  });

  it("sends requests through the injected fetch without SDK retries", async () => {
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    const origin = "https://openai.test";
    let requests = 0;
    dispatcher
      .get(origin)
      .intercept({ path: /.*/, method: "POST" })
      .reply(() => {
        requests += 1;
        return {
          statusCode: 500,
          data: { error: { message: "unavailable", type: "server_error" } },
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      });
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "test-key" },
      fetch: mockFetch(dispatcher),
      baseURL: origin,
    });

    try {
      await expect(
        adapter.complete(request, {
          signal: new AbortController().signal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        }),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
      expect(requests).toBe(1);
    } finally {
      await dispatcher.close();
    }
  });
});
