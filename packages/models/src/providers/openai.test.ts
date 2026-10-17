// SPDX-License-Identifier: Apache-2.0
import { JsonValue, ModelRequestSchema, parseJson } from "@harness/schemas";
import type { ModelRequest, Part } from "@harness/schemas";
import { MockAgent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import {
  CassetteProvider,
  type CassetteEntry,
  type CassetteStore,
} from "../cassette/cassette-provider.js";
import {
  assembleDeltas,
  ProviderResultSchema,
  type ProviderContext,
  type ProviderDelta,
  type ProviderResult,
} from "../types.js";
import { collectProviderStream } from "../streaming.js";
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

function streamedSseResponse(body: string): Response {
  const encoded = new TextEncoder().encode(body);
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.length; offset += 7) {
    pieces.push(encoded.slice(offset, offset + 7));
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(piece);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function delayedSseResponse(frames: readonly string[], delayMs: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function openAIEventStream(chunks: readonly JsonValue[], includeDone = true): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}${
    includeDone ? "data: [DONE]\n\n" : ""
  }`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function fixture(
  scenario: ProviderContractFixture["scenario"],
  status: number,
): ProviderContractFixture {
  let response: JsonValue;
  if (scenario === "tool_call") {
    response = completion(rawToolMessage);
  } else if (scenario === "usage_mapping") {
    response = {
      ...completion(textMessage),
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    };
  } else {
    response = completion(textMessage);
  }
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
      expected = {
        usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 },
        finishReason: "stop",
      };
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

function cassetteStore(): CassetteStore {
  const entries = new Map<string, CassetteEntry>();
  return {
    get: (hash) => Promise.resolve(entries.get(hash)?.response),
    set: (entry) => {
      entries.set(entry.hash, entry);
      return Promise.resolve();
    },
  };
}

function openAIAdapter(options: ProviderContractAdapterOptions) {
  return new OpenAIAdapter({
    apiKey: { reveal: () => "test-key" },
    fetch: adaptFetch(options.fetch),
    baseURL: options.baseUrl,
  });
}

const cassettePrivacy = {
  sanitize: (response: ProviderResult) => Promise.resolve(response),
  detectRealData: () => Promise.resolve(false),
};

runProviderContract("OpenAI Chat Completions contract", openAIAdapter, contractFixtures);
runProviderContract(
  "Cassette record adapter contract",
  (options) =>
    new CassetteProvider("record", cassetteStore(), openAIAdapter(options), cassettePrivacy),
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

  it("round-trips opaque parts under a configured provider id", () => {
    const provider = "openai-compatible";
    const response = fromChatResponse(
      {
        choices: [{ finish_reason: "tool_calls", message: rawToolMessage }],
        usage,
      },
      { next: () => id },
      provider,
    );
    const nextRequest = ModelRequestSchema.parse({
      ...request,
      model: { provider, model: "local-model" },
      messages: [{ role: "assistant", parts: response.parts }],
    });

    const mapped = toChatRequest(
      nextRequest,
      { structuredOutput: "none", parallelToolCalls: false },
      provider,
    );

    expect(mapped.messages[0]).toEqual(rawToolMessage);
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
      if (typeof options.body === "string") {
        secondRequest = parseJson(JsonValue, options.body);
      }
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
    const enforced = await enforceToolOutput(
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

  it("requests JSON mode when structured output is prompt-enforced", () => {
    const mapped = toChatRequest(
      {
        ...request,
        output: {
          name: "answer",
          schema: { type: "object" },
          schemaHash: "b".repeat(64),
        },
      },
      { structuredOutput: "json_mode", parallelToolCalls: false },
    );

    expect(mapped.response_format).toEqual({ type: "json_object" });
  });

  it("omits JSON mode for array-root output schemas", () => {
    const mapped = toChatRequest(
      {
        ...request,
        output: {
          name: "answer",
          schema: { type: "array", items: { type: "string" } },
          schemaHash: "b".repeat(64),
        },
      },
      { structuredOutput: "json_mode", parallelToolCalls: false },
    );

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

  it.each([
    { offsetMs: 2_500, expectedMs: 2_000 },
    { offsetMs: -2_500, expectedMs: 0 },
  ])("parses HTTP-date Retry-After using the injected clock", async ({ offsetMs, expectedMs }) => {
    const nowMs = Date.parse("2026-10-17T16:00:00.000Z");
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": new Date(nowMs + offsetMs).toUTCString(),
            },
          }),
        ),
    });

    await expect(
      adapter.complete(request, {
        signal: new AbortController().signal,
        ids: { next: () => id },
        clock: { now: () => nowMs },
      }),
    ).rejects.toMatchObject({ code: "provider_rate_limited", retryAfterMs: expectedMs });
  });
});

describe("OpenAI streaming adapter", () => {
  it("assembles text and reasoning deltas into the same opaque result as complete()", async () => {
    const message = {
      role: "assistant",
      content: "answer",
      reasoning_content: "private reasoning",
      refusal: null,
      annotations: [{ type: "url_citation", url: "https://example.test" }],
    };
    const chunks: JsonValue[] = [
      {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant", refusal: null }, finish_reason: null }],
      },
      {
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "private reasoning",
              annotations: [{ type: "url_citation", url: "https://example.test" }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chunk-3",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
      },
      {
        id: "chunk-4",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chunk-5",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [],
        usage,
      },
    ];
    const streamingAdapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () => Promise.resolve(openAIEventStream(chunks)),
    });
    const completeAdapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(completion(JsonValue.parse(message))), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const context: ProviderContext = {
      signal: new AbortController().signal,
      ids: { next: () => id },
      clock: { now: () => 0 },
    };
    const expected = await completeAdapter.complete(request, context);
    const deltas: ProviderDelta[] = [];
    for await (const delta of streamingAdapter.stream(request, context)) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas)).toEqual(expected);
    expect(JSON.stringify(assembleDeltas(deltas).parts)).toContain("private reasoning");
    expect(JSON.stringify(deltas.filter((delta) => delta.type === "activity"))).not.toContain(
      "private reasoning",
    );
  });

  it("assembles fragmented tool-call identifiers, names, and arguments", async () => {
    const chunks: JsonValue[] = [
      {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_openai_1",
                  type: "function",
                  function: { name: "look", arguments: '{"key":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "up", arguments: '"value"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chunk-3",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      {
        id: "chunk-4",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [],
        usage,
      },
    ];
    const streamingAdapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () => Promise.resolve(openAIEventStream(chunks)),
    });
    const completeAdapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(completion(JsonValue.parse(rawToolMessage), "tool_calls")), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const context: ProviderContext = {
      signal: new AbortController().signal,
      ids: { next: () => id },
      clock: { now: () => 0 },
    };
    const expected = await completeAdapter.complete(request, context);
    const deltas: ProviderDelta[] = [];
    for await (const delta of streamingAdapter.stream(request, context)) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas)).toEqual(expected);
  });

  it.each([true, false])(
    "rejects a response that reaches the end without a finish reason (DONE: %s)",
    async (includeDone) => {
      const partialChunk = JsonValue.parse({
        id: "chunk-partial",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      });
      const adapter = new OpenAIAdapter({
        apiKey: { reveal: () => "synthetic-test-key" },
        baseURL: "https://provider.test/v1",
        fetch: () => Promise.resolve(openAIEventStream([partialChunk], includeDone)),
      });
      const collect = async () => {
        const deltas: ProviderDelta[] = [];
        for await (const delta of adapter.stream(request, {
          signal: new AbortController().signal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        })) {
          deltas.push(delta);
        }
        return deltas;
      };

      await expect(collect()).rejects.toMatchObject({
        code: "provider_unavailable",
        retryable: true,
      });
    },
  );

  it("maps a mid-stream overloaded error to a retryable provider failure", async () => {
    const partialChunk = {
      id: "chunk-partial",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    };
    const error = {
      error: { type: "overloaded_error", message: "synthetic provider error" },
    };
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify(partialChunk)}\n\ndata: ${JSON.stringify(error)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    });
    const collect = async () => {
      const deltas: ProviderDelta[] = [];
      for await (const delta of adapter.stream(request, {
        signal: new AbortController().signal,
        ids: { next: () => id },
        clock: { now: () => 0 },
      })) {
        deltas.push(delta);
      }
      return deltas;
    };

    await expect(collect()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("parses CRLF, split multiline data, and keepalive frames through the SDK", async () => {
    const chunk = {
      id: "chunk-sse",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: "framed" }, finish_reason: null }],
    };
    const json = JSON.stringify(chunk);
    const split = json.indexOf(",") + 1;
    const finish = JSON.stringify({
      id: "chunk-finish",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          streamedSseResponse(
            `: keepalive\r\ndata: ${json.slice(0, split)}\r\ndata: ${json.slice(
              split,
            )}\r\n\r\ndata: ${finish}\r\n\r\ndata: [DONE]\r\n\r\n`,
          ),
        ),
    });
    const deltas: ProviderDelta[] = [];
    for await (const delta of adapter.stream(request, {
      signal: new AbortController().signal,
      ids: { next: () => id },
      clock: { now: () => 0 },
    })) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas).parts).toContainEqual({ type: "text", text: "framed" });
  });

  it("keeps reasoning-only and refusal-only chunks active without progress content", async () => {
    const chunks = [
      {
        id: "chunk-role",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "chunk-reasoning-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          { index: 0, delta: { reasoning_content: "private reasoning one" }, finish_reason: null },
        ],
      },
      {
        id: "chunk-reasoning-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          { index: 0, delta: { reasoning_content: "private reasoning two" }, finish_reason: null },
        ],
      },
      {
        id: "chunk-refusal",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { refusal: "private refusal" }, finish_reason: null }],
      },
      {
        id: "chunk-finish",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chunk-usage",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [],
        usage,
      },
    ];
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: () =>
        Promise.resolve(
          delayedSseResponse(
            [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"],
            8,
          ),
        ),
    });
    const progress: unknown[] = [];
    const deltas: ProviderDelta[] = [];
    const signal = new AbortController().signal;
    const result = await collectProviderStream({
      stream: async function* (streamSignal) {
        for await (const delta of adapter.stream(request, {
          signal: streamSignal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        })) {
          deltas.push(delta);
          yield delta;
        }
      },
      signal,
      idleTimeoutMs: 20,
      requestId: id,
      onProgress: (update) => progress.push(update),
    });

    expect(result.parts).toEqual([
      {
        type: "opaque",
        provider: "openai",
        blob: {
          message: {
            role: "assistant",
            content: null,
            refusal: "private refusal",
            reasoning_content: "private reasoning oneprivate reasoning two",
          },
          openaiCallIdByCallId: {},
        },
      },
    ]);
    expect(deltas.some((delta) => delta.type === "activity")).toBe(true);
    expect(JSON.stringify(deltas.filter((delta) => delta.type === "activity"))).not.toContain(
      "private reasoning",
    );
    expect(progress).toEqual([{ requestId: id, outputTokens: 3 }]);
    expect(JSON.stringify(progress)).not.toContain("private");
  });

  it("aborts the active provider fetch when the caller cancels", async () => {
    const controller = new AbortController();
    let readerStarted: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });
    let fetchSignal: AbortSignal | null | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            readerStarted?.();
            return new Promise<void>(() => undefined);
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test/v1",
      fetch: (input, init) => {
        fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        expect(fetchSignal).toBeDefined();
        return Promise.resolve(response);
      },
    });
    const collecting = collectProviderStream({
      stream: (signal) =>
        adapter.stream(request, {
          signal,
          ids: { next: () => id },
          clock: { now: () => 0 },
        }),
      signal: controller.signal,
      idleTimeoutMs: 1_000,
      requestId: id,
    });
    const rejected = expect(collecting).rejects.toThrow("caller cancelled");

    await reading;
    controller.abort(new Error("caller cancelled"));
    await rejected;
    expect(fetchSignal?.aborted).toBe(true);
  });
});

describe("OpenAI adapter request behavior", () => {
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
