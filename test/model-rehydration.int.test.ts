// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  AnthropicAdapter,
  ModelGateway,
  OpenAIAdapter,
  prepareMessagesForProvider,
} from "@harness/models";
import { Id, JsonValue, parseJson } from "@harness/schemas";
import type { KeyProvider, Message, NewEvent, Part } from "@harness/schemas";
import { AesGcmContentCodec, SqliteEventStore } from "@harness/store";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const runId = Id.parse("00000000000000000000000001");
const requestId = Id.parse("00000000000000000000000002");
const toolCallId = Id.parse("00000000000000000000000003");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const keyId = "rehydration-test-key";
const encryptionKey = new Uint8Array(32).fill(7);

const keyProvider: KeyProvider = {
  currentKeyId: () => keyId,
  getKey: () => Promise.resolve(Uint8Array.from(encryptionKey)),
};

const AnthropicRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.enum(["assistant", "user"]),
      content: z.array(JsonValue),
    }),
  ),
});

const OpenAIRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: JsonValue.optional(),
      refusal: z.union([z.string(), z.null()]).optional(),
      tool_calls: z
        .array(
          z.looseObject({
            id: z.string(),
            type: z.string(),
            function: z.looseObject({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
});

function context() {
  return {
    signal: new AbortController().signal,
    ids: { next: () => toolCallId },
    clock: { now: () => 1 },
  };
}

function conversationRequest(provider: "anthropic" | "openai", messages: Message[]) {
  return {
    requestId,
    model: { provider, model: provider === "anthropic" ? "claude-test" : "gpt-test" },
    messages,
    maxOutputTokens: 32,
  };
}

function initialMessages(): Message[] {
  return [{ role: "user", parts: [{ type: "text", text: "synthetic prompt" }] }];
}

async function persistAndReadResponse(provider: string, parts: Part[]): Promise<Part[]> {
  const directory = await mkdtemp(join(tmpdir(), "harness-model-rehydration-"));
  const store = new SqliteEventStore(
    join(directory, "events.sqlite"),
    new AesGcmContentCodec(keyProvider),
  );
  try {
    const events: NewEvent[] = [
      {
        runId,
        ts: 1,
        v: 1,
        traceId,
        spanId,
        segmentId: runId,
        type: "run_created",
        configHash: "a".repeat(64),
        policyVersion: "test.policy",
      },
      {
        runId,
        ts: 2,
        v: 1,
        traceId,
        spanId,
        segmentId: runId,
        type: "model_response",
        requestId,
        provider,
        model: provider === "anthropic" ? "claude-test" : "gpt-test",
        inputTokens: 1,
        outputTokens: 2,
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: parts,
        providerBlobs: null,
      },
    ];
    await store.append(runId, events, 0);
    for await (const event of store.read(runId, { fromSeq: 1 })) {
      if (event.type === "model_response") {
        return event.content;
      }
    }
    throw new Error("Missing stored model response");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("model response rehydration", () => {
  it("round-trips Anthropic thinking blocks through encrypted SQLite", async () => {
    const thinkingBlocks = [
      { type: "thinking", thinking: "synthetic reasoning", signature: "synthetic-signature" },
      { type: "text", text: "synthetic answer" },
    ];
    const response = {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: thinkingBlocks,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const requestBodies: z.infer<typeof AnthropicRequestSchema>[] = [];
    const fetch: typeof globalThis.fetch = (_input, init) => {
      if (typeof init?.body === "string") {
        requestBodies.push(parseJson(AnthropicRequestSchema, init.body));
      }
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const adapter = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch,
      baseURL: "https://provider.test",
    });
    const completion = await adapter.complete(
      conversationRequest("anthropic", initialMessages()),
      context(),
    );
    const storedParts = await persistAndReadResponse("anthropic", completion.parts);
    const messages = prepareMessagesForProvider(
      [...initialMessages(), { role: "assistant", parts: storedParts }],
      "anthropic",
    );

    await adapter.complete(conversationRequest("anthropic", messages), context());

    const body = requestBodies.at(-1);
    const assistantMessage = body?.messages.find(({ role }) => role === "assistant");
    if (assistantMessage === undefined) {
      throw new Error("Missing rehydrated Anthropic assistant message");
    }
    expect(JSON.stringify(assistantMessage.content)).toBe(JSON.stringify(thinkingBlocks));
  });

  it("round-trips the OpenAI raw assistant message through encrypted SQLite", async () => {
    const rawMessage = {
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: "call_provider_tool_id",
          type: "function",
          function: { name: "lookup", arguments: '{"key":"synthetic"}' },
        },
      ],
    };
    const response = {
      id: "chatcmpl_synthetic",
      object: "chat.completion",
      created: 1,
      model: "gpt-test",
      choices: [{ index: 0, message: rawMessage, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const requestBodies: z.infer<typeof OpenAIRequestSchema>[] = [];
    const fetch: typeof globalThis.fetch = (_input, init) => {
      if (typeof init?.body === "string") {
        requestBodies.push(parseJson(OpenAIRequestSchema, init.body));
      }
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const adapter = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch,
      baseURL: "https://provider.test/v1",
    });
    const completion = await adapter.complete(
      conversationRequest("openai", initialMessages()),
      context(),
    );
    const storedParts = await persistAndReadResponse("openai", completion.parts);
    const messages = prepareMessagesForProvider(
      [...initialMessages(), { role: "assistant", parts: storedParts }],
      "openai",
    );

    await adapter.complete(conversationRequest("openai", messages), context());

    const body = requestBodies.at(-1);
    const assistantMessage = body?.messages.find(({ role }) => role === "assistant");
    if (assistantMessage === undefined) {
      throw new Error("Missing rehydrated OpenAI assistant message");
    }
    expect(JSON.stringify(assistantMessage)).toBe(JSON.stringify(rawMessage));
  });

  it("continues with normalized tool calls and matching tool-result ids after a provider switch", async () => {
    const anthropicResponse = {
      id: "msg_tool_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "synthetic tool request" },
        {
          type: "tool_use",
          id: "toolu_provider_id",
          name: "lookup",
          input: { key: "synthetic" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const anthropic = new AnthropicAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      baseURL: "https://provider.test",
    });
    const completion = await anthropic.complete(
      conversationRequest("anthropic", initialMessages()),
      context(),
    );
    const storedParts = await persistAndReadResponse("anthropic", completion.parts);
    const requestBodies: z.infer<typeof OpenAIRequestSchema>[] = [];
    const openai = new OpenAIAdapter({
      apiKey: { reveal: () => "synthetic-test-key" },
      fetch: (_input, init) => {
        if (typeof init?.body === "string") {
          requestBodies.push(parseJson(OpenAIRequestSchema, init.body));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl_tool_synthetic",
              object: "chat.completion",
              created: 1,
              model: "gpt-test",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "synthetic done" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
      baseURL: "https://provider.test/v1",
    });

    const gateway = new ModelGateway(new AdapterRegistry([openai]), {
      ids: { next: () => toolCallId },
      clock: { now: () => 1 },
      providerStreaming: { openai: false },
    });
    await gateway.complete(
      conversationRequest("openai", [
        ...initialMessages(),
        { role: "assistant", parts: storedParts },
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: toolCallId, result: { found: true }, isError: false },
          ],
        },
      ]),
      { runId, signal: new AbortController().signal },
    );

    const body = requestBodies.at(-1);
    const assistantMessage = body?.messages.find(({ role }) => role === "assistant");
    const toolMessage = body?.messages.find(({ role }) => role === "tool");
    const providerToolCallId = assistantMessage?.tool_calls?.[0]?.id;
    if (providerToolCallId === undefined || toolMessage?.tool_call_id === undefined) {
      throw new Error("Missing switched-provider tool-call mapping");
    }
    expect(providerToolCallId).toBe(`call_${toolCallId}`);
    expect(toolMessage.tool_call_id).toBe(providerToolCallId);
  });
});
