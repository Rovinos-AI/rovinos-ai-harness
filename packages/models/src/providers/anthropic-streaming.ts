// SPDX-License-Identifier: Apache-2.0
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { JsonValue, type Id, type ModelUsage } from "@rovinos/schemas";
import { z as zod } from "zod";
import type { ProviderContext, ProviderDelta } from "../types.js";

type JsonValueType = zod.infer<typeof JsonValue>;

/** State required to map one Anthropic streaming response. */
export interface AnthropicStreamState {
  readonly callIdsByToolUseId: Map<string, zod.infer<typeof Id>>;
  readonly toolArgumentsByIndex: Map<number, string>;
  readonly toolIdsByIndex: Map<
    number,
    { readonly callId: zod.infer<typeof Id>; readonly toolId: string }
  >;
}

const AnthropicStreamingParamsSchema = zod.custom<MessageCreateParamsStreaming>((value) => {
  const parsed = JsonValue.safeParse(value);
  if (!parsed.success || !isJsonObject(parsed.data)) {
    return false;
  }
  const params = parsed.data;
  return (
    params.stream === true &&
    typeof params.model === "string" &&
    typeof params.max_tokens === "number" &&
    Array.isArray(params.messages) &&
    params.messages.every(
      (message) =>
        isJsonObject(message) &&
        (message.role === "user" || message.role === "assistant") &&
        (typeof message.content === "string" || Array.isArray(message.content)),
    )
  );
});

function isJsonObject(value: JsonValueType): value is Record<string, JsonValueType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the JSON request shape while retaining extensible provider content blocks. */
export function createAnthropicStreamingParams(
  params: JsonValueType,
): MessageCreateParamsStreaming {
  if (!isJsonObject(params)) {
    return AnthropicStreamingParamsSchema.parse(params);
  }
  return AnthropicStreamingParamsSchema.parse({ ...params, stream: true });
}

/** Creates isolated per-request state for provider event mapping. */
export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    callIdsByToolUseId: new Map(),
    toolArgumentsByIndex: new Map(),
    toolIdsByIndex: new Map(),
  };
}

function messageStartUsage(
  event: Extract<RawMessageStreamEvent, { type: "message_start" }>,
): ModelUsage {
  const usage = event.message.usage;
  return {
    inputTokens:
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    ...(typeof usage.cache_read_input_tokens !== "number"
      ? {}
      : { cacheReadTokens: usage.cache_read_input_tokens }),
    ...(typeof usage.cache_creation_input_tokens !== "number"
      ? {}
      : { cacheWriteTokens: usage.cache_creation_input_tokens }),
  };
}

function contentBlockStartDeltas(
  event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>,
  state: AnthropicStreamState,
  ids: ProviderContext["ids"],
): ProviderDelta[] {
  if (event.content_block.type === "text") {
    return [{ type: "text", index: event.index, text: "" }];
  }
  if (event.content_block.type !== "tool_use") {
    return [];
  }
  const callId = ids.next();
  state.callIdsByToolUseId.set(event.content_block.id, callId);
  state.toolIdsByIndex.set(event.index, { callId, toolId: event.content_block.name });
  state.toolArgumentsByIndex.set(event.index, "");
  return [
    {
      type: "tool_call",
      index: event.index,
      callId,
      toolId: event.content_block.name,
      arguments: "",
    },
  ];
}

function contentBlockDeltaDeltas(
  event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>,
  state: AnthropicStreamState,
): ProviderDelta[] {
  if (event.delta.type === "text_delta") {
    return [{ type: "text", index: event.index, text: event.delta.text }];
  }
  if (event.delta.type !== "input_json_delta") {
    return [];
  }
  const tool = state.toolIdsByIndex.get(event.index);
  if (tool === undefined) {
    return [];
  }
  state.toolArgumentsByIndex.set(
    event.index,
    (state.toolArgumentsByIndex.get(event.index) ?? "") + event.delta.partial_json,
  );
  return [
    {
      type: "tool_call",
      index: event.index,
      callId: tool.callId,
      arguments: event.delta.partial_json,
    },
  ];
}

function contentBlockStopDeltas(
  event: Extract<RawMessageStreamEvent, { type: "content_block_stop" }>,
  state: AnthropicStreamState,
): ProviderDelta[] {
  const tool = state.toolIdsByIndex.get(event.index);
  if (tool === undefined || state.toolArgumentsByIndex.get(event.index) !== "") {
    return [];
  }
  return [{ type: "tool_call", index: event.index, callId: tool.callId, arguments: "{}" }];
}

/** Maps provider streaming events into provider-neutral deltas. */
export function streamEventDeltas(
  event: RawMessageStreamEvent,
  state: AnthropicStreamState,
  ids: ProviderContext["ids"],
  usage: ModelUsage,
): { readonly deltas: ProviderDelta[]; readonly usage: ModelUsage } {
  let currentUsage = usage;
  let deltas: ProviderDelta[] = [];
  if (event.type === "message_start") {
    currentUsage = messageStartUsage(event);
    deltas = [{ type: "usage", usage: currentUsage }];
  } else if (event.type === "content_block_start") {
    deltas = contentBlockStartDeltas(event, state, ids);
  } else if (event.type === "content_block_delta") {
    deltas = contentBlockDeltaDeltas(event, state);
  } else if (event.type === "content_block_stop") {
    deltas = contentBlockStopDeltas(event, state);
  } else if (event.type === "message_delta") {
    currentUsage = { ...currentUsage, outputTokens: event.usage.output_tokens };
    deltas = [{ type: "usage", usage: currentUsage }];
  }
  return { deltas: deltas.length === 0 ? [{ type: "activity" }] : deltas, usage: currentUsage };
}
