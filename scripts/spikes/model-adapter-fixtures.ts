// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

/** Adapter implementation being evaluated. */
export type Approach = "thin" | "ai-sdk";
/** Provider used by one scenario. */
export type Provider = "anthropic" | "openai";
/** Request/response shape exercised by the spike. */
export type Scenario = "plain-text" | "forced-tool" | "multi-turn";

/** Captured JSON request sent through an SDK's injected fetch function. */
export interface CapturedRequest {
  readonly body: JsonRecord;
}

/** Results used to print one scenario row without response content. */
export interface ScenarioResult {
  readonly passed: boolean;
  readonly rawBlobRoundTrip: boolean | undefined;
}

/** JSON-compatible value schema used for fixture and request parsing. */
export const JsonValueSchema = z.json();
export const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
/** Inferred JSON object type used by the local mock transport. */
export type JsonRecord = z.infer<typeof JsonRecordSchema>;

export const ToolInputSchema = z.object({ query: z.string() }).strict();
export const ToolJsonSchema = parseJson(
  z.object({
    type: z.literal("object"),
    properties: z.object({ query: z.object({ type: z.literal("string") }) }),
    required: z.array(z.string()),
    additionalProperties: z.boolean(),
  }),
  JSON.stringify(z.toJSONSchema(ToolInputSchema)),
);

export const AnthropicBlockSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.looseObject({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: JsonValueSchema,
  }),
  z.looseObject({ type: z.literal("text"), text: z.string() }),
]);

export const StoredAnthropicAssistantSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.array(AnthropicBlockSchema),
});

const OpenAIToolCallSchema = z.looseObject({
  id: z.string(),
  type: z.literal("function"),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

export const StoredOpenAIAssistantSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  tool_calls: z.array(OpenAIToolCallSchema),
});

export const OpenAIResponseSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: StoredOpenAIAssistantSchema })),
});

const AiAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("reasoning"),
        text: z.string(),
        providerOptions: z
          .object({ anthropic: z.object({ signature: z.string() }) })
          .optional(),
      }),
      z.object({
        type: z.literal("tool-call"),
        toolCallId: z.string(),
        toolName: z.string(),
        input: JsonValueSchema,
      }),
      z.object({ type: z.literal("text"), text: z.string() }),
    ]),
  ),
});

const AiToolMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.array(
    z.object({
      type: z.literal("tool-result"),
      toolCallId: z.string(),
      toolName: z.string(),
      output: z.object({ type: z.literal("text"), value: z.string() }),
    }),
  ),
});

export const AiStoredMessageSchema = z.discriminatedUnion("role", [
  AiAssistantMessageSchema,
  AiToolMessageSchema,
]);

export const AnthropicRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([z.string(), z.array(JsonValueSchema)]),
    }),
  ),
});

export const OpenAIRequestSchema = z.looseObject({
  messages: z.array(JsonRecordSchema),
});

const anthropicPlainResponse: JsonRecord = {
  id: "msg_plain",
  type: "message",
  role: "assistant",
  model: "claude-spike-model",
  content: [{ type: "text", text: "synthetic plain response" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 3 },
};

const anthropicToolResponse: JsonRecord = {
  id: "msg_tool",
  type: "message",
  role: "assistant",
  model: "claude-spike-model",
  content: [
    {
      type: "tool_use",
      id: "toolu_fixture",
      name: "lookup",
      input: { query: "synthetic query" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 3 },
};

const anthropicMultiTurnResponse: JsonRecord = {
  id: "msg_multi",
  type: "message",
  role: "assistant",
  model: "claude-spike-model",
  content: [
    {
      type: "thinking",
      thinking: "synthetic reasoning",
      signature: "signature-fixture",
    },
    {
      type: "tool_use",
      id: "toolu_roundtrip",
      name: "lookup",
      input: { query: "synthetic query" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 3 },
};

const anthropicFollowUpResponse: JsonRecord = {
  id: "msg_followup",
  type: "message",
  role: "assistant",
  model: "claude-spike-model",
  content: [{ type: "text", text: "synthetic follow-up" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 3 },
};

const openaiPlainResponse: JsonRecord = {
  id: "chatcmpl_plain",
  object: "chat.completion",
  created: 1,
  model: "openai-spike-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "synthetic plain response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

const openaiToolResponse: JsonRecord = {
  id: "chatcmpl_tool",
  object: "chat.completion",
  created: 1,
  model: "openai-spike-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fixture",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"synthetic query"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

const openaiMultiTurnResponse: JsonRecord = {
  id: "chatcmpl_multi",
  object: "chat.completion",
  created: 1,
  model: "openai-spike-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_roundtrip",
            type: "function",
            function: { name: "lookup", arguments: '{ "query" : "synthetic query" }' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

const openaiFollowUpResponse: JsonRecord = {
  id: "chatcmpl_followup",
  object: "chat.completion",
  created: 1,
  model: "openai-spike-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "synthetic follow-up" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

/** Intercepts SDK requests and returns the queued local fixture responses. */
export function fixtureFetch(
  responses: readonly JsonRecord[],
  requests: CapturedRequest[],
): typeof fetch {
  let responseIndex = 0;

  return async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      body: parseJson(JsonRecordSchema, await request.text()),
    });

    const body = responses[responseIndex];
    responseIndex += 1;
    if (body === undefined) {
      return new Response(null, { status: 500 });
    }

    const responseText = JSON.stringify(body);
    return new Response(responseText, {
      headers: { "content-type": "application/json" },
    });
  };
}

/** Selects fixture responses for one provider and scenario. */
export function responseFixtures(provider: Provider, scenario: Scenario): JsonRecord[] {
  if (provider === "anthropic") {
    if (scenario === "plain-text") {
      return [anthropicPlainResponse];
    }
    if (scenario === "forced-tool") {
      return [anthropicToolResponse];
    }
    return [anthropicMultiTurnResponse, anthropicFollowUpResponse];
  }

  if (scenario === "plain-text") {
    return [openaiPlainResponse];
  }
  if (scenario === "forced-tool") {
    return [openaiToolResponse];
  }
  return [openaiMultiTurnResponse, openaiFollowUpResponse];
}

/** Returns the raw tool-use response used for multi-turn comparisons. */
export function rawMultiTurnResponse(provider: Provider): JsonRecord {
  return provider === "anthropic" ? anthropicMultiTurnResponse : openaiMultiTurnResponse;
}
