// SPDX-License-Identifier: Apache-2.0
import {
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

const FunctionCallSchema = z
  .object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }).passthrough(),
  })
  .passthrough();

const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    tool_calls: z.array(FunctionCallSchema).nullish(),
    refusal: z.string().nullable().optional(),
  })
  .passthrough();

const OpaqueBlobSchema = z
  .object({
    message: AssistantMessageSchema,
    openaiCallIdByCallId: z.record(z.string(), z.string()),
  })
  .passthrough();

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
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: string;
        readonly function?: { readonly name: string; readonly arguments: string };
      }[] | null;
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } | null;
}

function providerCallIdByCallId(messages: ModelRequest["messages"]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "opaque" || part.provider !== "openai") {
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
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function assistantMessage(
  requestMessage: ModelRequest["messages"][number],
  callIds: ReadonlyMap<string, string>,
): ChatCompletionAssistantMessageParam {
  for (const part of requestMessage.parts) {
    if (part.type !== "opaque" || part.provider !== "openai") {
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
    content: textContent(requestMessage.parts) || (toolCalls.length > 0 ? null : ""),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
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
): ChatCompletionCreateParamsNonStreaming {
  const callIds = providerCallIdByCallId(request.messages);
  const messages: ChatCompletionMessageParam[] = [];

  for (const message of request.messages) {
    if (message.role === "assistant") {
      messages.push(assistantMessage(message, callIds));
    } else if (message.role === "system" || message.role === "user") {
      messages.push({ role: message.role, content: textContent(message.parts) });
    } else {
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: callIds.get(part.callId) ?? `call_${part.callId}`,
            content: JSON.stringify(part.result),
          });
        }
      }
    }
  }

  const tools =
    request.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.toolId,
        description: tool.description,
        parameters: z.record(z.string(), JsonValue).parse(tool.inputSchema),
      },
    })) ?? [];

  return {
    model: request.model.model,
    messages,
    ...(tools.length > 0 && request.toolChoice !== "none" ? { tools } : {}),
    ...(request.toolChoice === undefined ? {} : {
      tool_choice:
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : { type: "function" as const, function: { name: request.toolChoice.forced } },
    }),
    parallel_tool_calls: quirks.parallelToolCalls,
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.output === undefined || quirks.structuredOutput !== "native"
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: request.output.name,
              schema: z.record(z.string(), JsonValue).parse(request.output.schema),
              strict: true,
            },
          },
        }),
  };
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

  let invalidToolArguments = false;
  const openaiCallIdByCallId: Record<string, string> = {};
  const parts: ModelRequest["messages"][number]["parts"] = [];
  const toolCalls = choice.message.tool_calls ?? [];
  for (const toolCall of toolCalls) {
    if (toolCall.function === undefined) {
      continue;
    }
    let args;
    try {
      args = parseJson(JsonValue, toolCall.function.arguments);
    } catch {
      invalidToolArguments = true;
      continue;
    }
    const callId = ids.next();
    openaiCallIdByCallId[callId] = toolCall.id;
    parts.push({ type: "tool_call", callId, toolId: toolCall.function.name, args });
  }

  if (!invalidToolArguments && choice.message.content !== null) {
    parts.unshift({ type: "text", text: choice.message.content });
  }

  parts.push({
    type: "opaque",
    provider: "openai",
    blob: JsonValue.parse({
      message: choice.message,
      openaiCallIdByCallId,
    }),
  });

  const finishReason = invalidToolArguments
    ? "tool_args_invalid"
    : choice.finish_reason === "content_filter"
      ? "provider_content_filtered"
      : (choice.finish_reason ?? "other");
  return {
    parts,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    finishReason,
  };
}
