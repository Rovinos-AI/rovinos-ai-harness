// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  parseJson,
  type Capabilities,
  type Id,
  type ModelRequest,
} from "@harness/schemas";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";

const FunctionCallSchema = z.looseObject({
  id: z.string(),
  type: z.literal("function"),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

const AssistantMessageSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  tool_calls: z.array(FunctionCallSchema).nullish(),
  refusal: z.string().nullable().optional(),
});

const OpaqueBlobSchema = z.looseObject({
  message: AssistantMessageSchema,
  openaiCallIdByCallId: z.record(z.string(), z.string()),
});

/** Provider quirks that affect the shared Chat Completions request mapper. */
export interface ChatCompletionsQuirks {
  readonly structuredOutput: Capabilities["structuredOutput"];
  readonly parallelToolCalls: boolean;
}

/** The subset of a Chat Completions response consumed by the shared mapper. */
export interface ChatCompletionLike {
  readonly choices: readonly {
    readonly finish_reason: string | null;
    readonly message: {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?:
        | readonly {
            readonly id: string;
            readonly type: string;
            readonly function?: { readonly name: string; readonly arguments: string };
          }[]
        | null;
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } | null;
}

function providerCallIdByCallId(
  messages: ModelRequest["messages"],
  provider: string,
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "opaque" || part.provider !== provider) {
        continue;
      }
      const blob = OpaqueBlobSchema.safeParse(part.blob);
      if (blob.success) {
        for (const [callId, providerCallId] of Object.entries(blob.data.openaiCallIdByCallId)) {
          ids.set(callId, providerCallId);
        }
      }
    }
  }
  return ids;
}

function textContent(parts: ModelRequest["messages"][number]["parts"]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function assistantContent(parts: ModelRequest["messages"][number]["parts"], hasToolCalls: boolean) {
  const content = textContent(parts);
  if (content.length > 0) {
    return content;
  }
  return hasToolCalls ? null : "";
}

function assistantMessage(
  requestMessage: ModelRequest["messages"][number],
  callIds: ReadonlyMap<string, string>,
  provider: string,
): ChatCompletionAssistantMessageParam {
  for (const part of requestMessage.parts) {
    if (part.type !== "opaque" || part.provider !== provider) {
      continue;
    }
    const blob = OpaqueBlobSchema.safeParse(part.blob);
    if (blob.success) {
      const { refusal, tool_calls: toolCalls, ...rawFields } = blob.data.message;
      return {
        ...rawFields,
        ...(toolCalls === undefined || toolCalls === null ? {} : { tool_calls: toolCalls }),
        ...(refusal === undefined ? {} : { refusal }),
      };
    }
  }

  const toolCalls = requestMessage.parts.flatMap((part) =>
    part.type === "tool_call"
      ? [
          {
            id: callIds.get(part.callId) ?? `call_${part.callId}`,
            type: "function" as const,
            function: { name: part.toolId, arguments: JSON.stringify(part.args) },
          },
        ]
      : [],
  );
  return {
    role: "assistant",
    content: assistantContent(requestMessage.parts, toolCalls.length > 0),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function mapMessages(
  messages: ModelRequest["messages"],
  provider: string,
): ChatCompletionMessageParam[] {
  const callIds = providerCallIdByCallId(messages, provider);
  const mapped: ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      mapped.push(assistantMessage(message, callIds, provider));
    } else if (message.role === "system" || message.role === "user") {
      mapped.push({ role: message.role, content: textContent(message.parts) });
    } else {
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          mapped.push({
            role: "tool",
            tool_call_id: callIds.get(part.callId) ?? `call_${part.callId}`,
            content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
          });
        }
      }
    }
  }
  return mapped;
}

function mapTools(request: ModelRequest): Pick<ChatCompletionCreateParamsNonStreaming, "tools"> {
  const tools =
    request.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.toolId,
        description: tool.description,
        parameters: z.record(z.string(), JsonValue).parse(tool.inputSchema),
      },
    })) ?? [];
  return tools.length > 0 && request.toolChoice !== "none" ? { tools } : {};
}

function mapToolChoice(
  request: ModelRequest,
): Pick<ChatCompletionCreateParamsNonStreaming, "tool_choice"> {
  if (request.toolChoice === undefined) {
    return {};
  }
  if (typeof request.toolChoice === "string") {
    return { tool_choice: request.toolChoice };
  }
  return {
    tool_choice: {
      type: "function",
      function: { name: request.toolChoice.forced },
    },
  };
}

function mapOutputFormat(
  request: ModelRequest,
  quirks: ChatCompletionsQuirks,
): Pick<ChatCompletionCreateParamsNonStreaming, "response_format"> {
  if (request.output === undefined) {
    return {};
  }
  const schema = z.record(z.string(), JsonValue).safeParse(request.output.schema);
  if (quirks.structuredOutput === "json_mode" && schema.success && schema.data.type === "object") {
    return { response_format: { type: "json_object" } };
  }
  if (quirks.structuredOutput !== "native") {
    return {};
  }
  return {
    response_format: {
      type: "json_schema",
      json_schema: {
        name: request.output.name,
        schema: z.record(z.string(), JsonValue).parse(request.output.schema),
        strict: true,
      },
    },
  };
}

/**
 * Converts a normalized model request to an OpenAI Chat Completions request.
 *
 * @param request - JSON-serializable normalized model request.
 * @param quirks - Provider capabilities that vary between compatible endpoints.
 * @returns SDK-compatible request parameters.
 */
export function toChatRequest(
  request: ModelRequest,
  quirks: ChatCompletionsQuirks,
  provider = "openai",
): ChatCompletionCreateParamsNonStreaming {
  const tools = mapTools(request);
  return {
    model: request.model.model,
    messages: mapMessages(request.messages, provider),
    ...tools,
    ...mapToolChoice(request),
    ...(tools.tools === undefined ? {} : { parallel_tool_calls: quirks.parallelToolCalls }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...mapOutputFormat(request, quirks),
  };
}

function mapToolCalls(
  toolCalls: NonNullable<ChatCompletionLike["choices"][number]["message"]["tool_calls"]>,
  ids: { readonly next: () => Id },
): {
  readonly parts: ModelRequest["messages"][number]["parts"];
  readonly openaiCallIdByCallId: Record<string, string>;
  readonly invalidArguments: boolean;
} {
  const parts: ModelRequest["messages"][number]["parts"] = [];
  const openaiCallIdByCallId: Record<string, string> = {};
  let invalidArguments = false;

  for (const toolCall of toolCalls) {
    if (toolCall.function === undefined) {
      continue;
    }
    let args;
    const toolId = Code.safeParse(toolCall.function.name);
    if (!toolId.success) {
      invalidArguments = true;
      continue;
    }
    try {
      args = parseJson(JsonValue, toolCall.function.arguments);
    } catch {
      invalidArguments = true;
      continue;
    }
    const callId = ids.next();
    openaiCallIdByCallId[callId] = toolCall.id;
    parts.push({ type: "tool_call", callId, toolId: toolId.data, args });
  }
  return { parts, openaiCallIdByCallId, invalidArguments };
}

function mapFinishReason(reason: string | null, invalidArguments: boolean): string {
  if (invalidArguments) {
    return "tool_args_invalid";
  }
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
      return reason;
    case "content_filter":
      return "provider_content_filtered";
    case null:
      return "other";
    default:
      return reason;
  }
}

/**
 * Converts an OpenAI Chat Completions response into normalized parts and usage.
 *
 * @param response - Provider response with the fields consumed by this mapper.
 * @param ids - Generator for harness-owned call identifiers.
 * @returns Normalized assistant parts, usage, and finish reason.
 */
export function fromChatResponse(
  response: ChatCompletionLike,
  ids: { readonly next: () => Id },
  provider = "openai",
): {
  readonly parts: ModelRequest["messages"][number]["parts"];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly finishReason: string;
} {
  const choice = response.choices[0];
  if (choice === undefined) {
    return {
      parts: [],
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      finishReason: "other",
    };
  }

  const mappedCalls = mapToolCalls(choice.message.tool_calls ?? [], ids);
  const parts = mappedCalls.invalidArguments ? [] : mappedCalls.parts;

  if (!mappedCalls.invalidArguments && choice.message.content !== null) {
    parts.unshift({ type: "text", text: choice.message.content });
  }

  parts.push({
    type: "opaque",
    provider: Code.parse(provider),
    blob: JsonValue.parse({
      message: choice.message,
      openaiCallIdByCallId: mappedCalls.openaiCallIdByCallId,
    }),
  });

  return {
    parts,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    finishReason: mapFinishReason(choice.finish_reason, mappedCalls.invalidArguments),
  };
}
