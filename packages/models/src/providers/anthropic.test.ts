// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { ClientOptions } from "@anthropic-ai/sdk";
import { JsonValue, ModelRetryConfigSchema, parseJson } from "@rovinos/schemas";
import type { ModelRequest } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ProviderContractFixtureSchema,
  runProviderContract,
  type ProviderContractAdapterOptions,
  type ProviderContractFixture,
} from "../contract.js";
import { ProviderError } from "../errors.js";
import { withPromptOutput } from "../enforce/rung-prompt.js";
import { assembleDeltas, ProviderResultSchema } from "../types.js";
import type { ProviderDelta } from "../types.js";
import { collectProviderStream } from "../streaming.js";
import { withRetries } from "../resilience/retry.js";
import { enforceToolOutput } from "../enforce/rung-tool.js";
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
  provider = "anthropic",
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
      provider,
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

function anthropicEventStream(events: readonly JsonValue[]): Response {
  const body = events
    .map((event) => {
      const value = z.object({ type: z.string() }).loose().parse(event);
      return `event: ${value.type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function streamedSseResponse(frames: readonly string[], delayMs = 0): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function fixtureFactory(
  options: ProviderContractAdapterOptions,
  _fixture: ProviderContractFixture,
): AnthropicAdapter {
  return adapterFor(options.fetch, options.baseUrl);
}

runProviderContract("Anthropic Messages API contract", fixtureFactory, fixtures);

describe("AnthropicAdapter", () => {
  it("assembles streamed text, tool calls, and thinking blocks exactly like complete()", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        ...responseBody,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    };
    const events: JsonValue[] = [
      messageStart,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_fixture" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_fixture", name: "lookup", input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 11 },
      },
      { type: "message_stop" },
    ];
    let streamedRequest: JsonValue | undefined;
    const streamingAdapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test",
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a serialized Anthropic request body.");
        }
        streamedRequest = parseJson(JsonValue, init.body);
        return Promise.resolve(anthropicEventStream(events));
      },
    });

    const expected = await makeRequest().adapter.complete(baseRequest, context());
    const deltas: ProviderDelta[] = [];
    for await (const delta of streamingAdapter.stream(baseRequest, context())) {
      deltas.push(delta);
    }

    expect(assembleDeltas(deltas)).toEqual(expected);
    expect(streamedRequest).toMatchObject({ stream: true });
    expect(JSON.stringify(assembleDeltas(deltas).parts)).toContain("sig_fixture");
    expect(deltas.some((delta) => delta.type === "activity")).toBe(true);
    expect(deltas.filter((delta) => delta.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 7, outputTokens: 1 } },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 11 } },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 11 } },
    ]);
  });

  it("keeps long thinking and signature phases active without emitting their content", async () => {
    const events: JsonValue[] = [
      {
        type: "message_start",
        message: {
          ...responseBody,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      ...["private-one", "private-two"].map((thinking): JsonValue => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking },
      })),
      ...Array.from({ length: 12 }, (_, index): JsonValue => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: `private-${String(index)}` },
      })),
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "private-signature" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    const frames = events.flatMap((event) => {
      const { type } = z.object({ type: z.string() }).loose().parse(event);
      const json = JSON.stringify(event);
      const split = json.indexOf(",") + 1;
      return [
        ": keepalive\r\n",
        `event: ${type}\r\nda`,
        `ta: ${json.slice(0, split)}\r\n`,
        `data: ${json.slice(split)}\r\n\r\n`,
      ];
    });
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test",
      // ~72 frames 40 ms apart run ~3 s, well past the idle timeout, so only keep-alive and thinking
      // frames keep the stream alive; the 25x margin tolerates a loaded CI agent.
      fetch: () => Promise.resolve(streamedSseResponse(frames, 40)),
    });
    const progress: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await collectProviderStream({
      stream: (streamSignal) => adapter.stream(baseRequest, context(streamSignal)),
      signal,
      idleTimeoutMs: 1_000,
      requestId,
      onProgress: (update) => progress.push(update),
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(progress).toEqual([
      { requestId, outputTokens: 0 },
      { requestId, outputTokens: 2 },
    ]);
    expect(JSON.stringify(progress)).not.toContain("private-one");
    expect(JSON.stringify(result.parts)).toContain("private-signature");
  });

  it.each([
    ["overloaded_error", "provider_unavailable"],
    ["api_error", "provider_unavailable"],
    ["rate_limit_error", "provider_rate_limited"],
  ] as const)("maps an HTTP-200 %s stream error to %s", async (type, code) => {
    const start = {
      type: "message_start",
      message: {
        ...responseBody,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    const partial = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
    const body = [
      `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify(partial)}\n\n`,
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type, message: "synthetic error" },
      })}\n\n`,
    ].join("");
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test",
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    });
    const collect = async () => {
      const deltas: ProviderDelta[] = [];
      for await (const delta of adapter.stream(baseRequest, context())) {
        deltas.push(delta);
      }
      return deltas;
    };

    await expect(collect()).rejects.toMatchObject({ code, retryable: true });
  });

  it("discards partial Anthropic output when retrying a mid-stream error", async () => {
    const start = {
      type: "message_start",
      message: {
        ...responseBody,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    const firstAttempt = [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "discard me" },
      },
    ];
    const secondAttempt = [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "second only" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    let attempt = 0;
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test",
      fetch: () => {
        attempt += 1;
        const eventFrames =
          attempt === 1
            ? [
                ...firstAttempt.map(
                  (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
                `event: error\ndata: ${JSON.stringify({
                  type: "error",
                  error: { type: "overloaded_error", message: "synthetic overload" },
                })}\n\n`,
              ]
            : secondAttempt.map(
                (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
        return Promise.resolve(streamedSseResponse(eventFrames));
      },
    });

    const result = await withRetries({
      policy: ModelRetryConfigSchema.parse({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 }),
      clock: { now: () => 0 },
      random: () => 0,
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
      operation: (signal) =>
        collectProviderStream({
          stream: (streamSignal) => adapter.stream(baseRequest, context(streamSignal)),
          signal,
          idleTimeoutMs: 100,
          requestId,
        }),
    });

    expect(attempt).toBe(2);
    expect(result.parts).toContainEqual({ type: "text", text: "second only" });
    expect(JSON.stringify(result.parts)).not.toContain("discard me");
  });

  it("aborts the Anthropic fetch body when the caller cancels", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let bodyCancelled = false;
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      baseURL: "https://provider.test",
      fetch: (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        const start = {
          type: "message_start",
          message: {
            ...responseBody,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        };
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                bodyCancelled = true;
                streamController.error(new Error("fetch body aborted"));
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      },
    });

    const completion = collectProviderStream({
      stream: (signal) => adapter.stream(baseRequest, context(signal)),
      signal: controller.signal,
      idleTimeoutMs: 1_000,
      requestId,
      onProgress: () => {
        controller.abort(new Error("caller cancelled"));
      },
    });

    await expect(completion).rejects.toMatchObject({ message: "caller cancelled" });
    expect(fetchSignal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  it.each([
    { offsetMs: 2_500, expectedMs: 2_000 },
    { offsetMs: -2_500, expectedMs: 0 },
  ])("parses HTTP-date Retry-After using the injected clock", async ({ offsetMs, expectedMs }) => {
    const nowMs = Date.parse("2026-10-17T16:00:00.000Z");
    const { adapter } = makeRequest(responseBody, 429, {
      "retry-after": new Date(nowMs + offsetMs).toUTCString(),
    });

    await expect(
      adapter.complete(baseRequest, {
        signal: new AbortController().signal,
        ids: { next: () => requestId },
        clock: { now: () => nowMs },
      }),
    ).rejects.toMatchObject({ code: "provider_rate_limited", retryAfterMs: expectedMs });
  });

  it("places three cache breakpoints and maps cached usage without mutating recorded content", async () => {
    const call = makeRequest({
      ...responseBody,
      usage: {
        input_tokens: 7,
        output_tokens: 11,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    });
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        { role: "system", parts: [{ type: "text", text: "system rule" }] },
        { role: "user", parts: [{ type: "text", text: "hello" }] },
      ],
      stablePrefixMessages: 2,
    };
    const originalRequest = JSON.stringify(request);

    const result = await call.adapter.complete(request, context());
    const body = z
      .object({
        system: z.array(JsonValue),
        tools: z.array(JsonValue),
        messages: z.array(JsonValue),
      })
      .parse(call.getRequestBody());

    expect(body.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(body.tools.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(body.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    });
    expect(JSON.stringify(body).match(/"cache_control"/gu)).toHaveLength(3);
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 11,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    });
    expect(result.parts.find((part) => part.type === "opaque")).toMatchObject({
      blob: { content: rawContent },
    });
    expect(JSON.stringify(request)).toBe(originalRequest);
  });

  it("omits cache breakpoints when the request has no stable prefix, system prompt, or tools", async () => {
    const call = makeRequest();
    await call.adapter.complete(
      {
        ...baseRequest,
        messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        tools: [],
        toolChoice: "none",
        stablePrefixMessages: 0,
      },
      context(),
    );

    expect(JSON.stringify(call.getRequestBody())).not.toContain("cache_control");
  });

  it("places a conversation breakpoint after a prepended prompt-output instruction", async () => {
    const request = withPromptOutput(
      {
        ...baseRequest,
        messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        stablePrefixMessages: 1,
      },
      { name: "result", schema: { type: "object" }, schemaHash: "a".repeat(64) },
    );
    const call = makeRequest();

    await call.adapter.complete(request, context());

    const body = z.object({ messages: JsonValue }).parse(call.getRequestBody());
    expect(body.messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("omits cache usage fields when the provider response does not include them", async () => {
    const call = makeRequest();

    const result = await call.adapter.complete(baseRequest, context());

    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
    expect(Object.hasOwn(result.usage, "cacheReadTokens")).toBe(false);
    expect(Object.hasOwn(result.usage, "cacheWriteTokens")).toBe(false);
  });

  it("exposes capability overrides to the gateway", () => {
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      capabilities: { forcedToolChoice: false },
    });

    expect(adapter.capabilities).toEqual({ forcedToolChoice: false });
  });

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

  it("round-trips opaque parts under a configured provider id", async () => {
    const provider = "anthropic-custom";
    const response = makeRequest(responseBody, 200, {}, provider);
    const request: ModelRequest = {
      ...baseRequest,
      model: { provider, model: "claude-sonnet-5-5" },
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "opaque",
              provider,
              blob: { content: rawContent, toolUseIdByCallId: {} },
            },
          ],
        },
      ],
    };

    await response.adapter.complete(request, context());

    const body = response.getRequestBody();
    expect(body).toMatchObject({
      messages: [{ role: "assistant", content: rawContent }],
    });
  });

  it("does not replay a forced synthetic tool call from opaque Anthropic content", async () => {
    const providerResult = await makeRequest({
      ...responseBody,
      content: [
        { type: "thinking", thinking: "private reasoning", signature: "sig_fixture" },
        { type: "text", text: "structured result" },
        {
          type: "tool_use",
          id: "toolu_emit_result",
          name: "emit_result",
          input: { answer: "ok" },
        },
      ],
    }).adapter.complete(baseRequest, context());
    const enforced = await enforceToolOutput(
      providerResult.parts,
      z.object({ answer: z.string() }).strict(),
    );
    const next = makeRequest({ ...responseBody, content: [] });
    await next.adapter.complete(
      {
        ...baseRequest,
        messages: [...baseRequest.messages, { role: "assistant", parts: enforced.parts }],
      },
      context(),
    );

    const body = z.object({ messages: JsonValue }).parse(next.getRequestBody());
    expect(JSON.stringify(body.messages)).not.toContain("emit_result");
    expect(body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "sig_fixture" },
          { type: "text", text: "structured result" },
        ],
      },
    ]);
  });

  it("does not mutate opaque history when merging assistant turns on repeated requests", async () => {
    const request: ModelRequest = {
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "assistant",
          parts: [
            {
              type: "opaque",
              provider: "anthropic",
              blob: { content: structuredClone(rawContent) },
            },
          ],
        },
        { role: "assistant", parts: [{ type: "text", text: "continuation" }] },
      ],
      stablePrefixMessages: 2,
    };
    const original = JSON.stringify(request);
    const first = makeRequest();
    await first.adapter.complete(request, context());
    const second = makeRequest();
    await second.adapter.complete(request, context());
    expect(JSON.stringify(request)).toBe(original);
    expect(second.getRequestBody()).toEqual(first.getRequestBody());
    const body = z.object({ messages: JsonValue }).parse(first.getRequestBody());
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          ...rawContent.slice(0, -1),
          {
            type: "tool_use",
            id: "toolu_fixture",
            name: "lookup",
            input: { query: "x" },
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "continuation" },
        ],
      },
    ]);
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
    expect(requestBody.system).toEqual([
      { type: "text", text: "system rule", cache_control: { type: "ephemeral" } },
    ]);
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
