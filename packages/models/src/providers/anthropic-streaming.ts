// SPDX-License-Identifier: Apache-2.0
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { JsonValue } from "@harness/schemas";
import type { Id } from "@harness/schemas";
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

/** Maps provider streaming events into provider-neutral deltas. */
export function* streamEventDeltas(
  event: RawMessageStreamEvent,
  state: AnthropicStreamState,
  ids: ProviderContext["ids"],
): Generator<ProviderDelta> {
  if (event.type === "content_block_start") {
    if (event.content_block.type === "text") {
      yield { type: "text", index: event.index, text: "" };
    } else if (event.content_block.type === "tool_use") {
      const callId = ids.next();
      state.callIdsByToolUseId.set(event.content_block.id, callId);
      state.toolIdsByIndex.set(event.index, {
        callId,
        toolId: event.content_block.name,
      });
      state.toolArgumentsByIndex.set(event.index, "");
      yield {
        type: "tool_call",
        index: event.index,
        callId,
        toolId: event.content_block.name,
        arguments: "",
      };
    }
  } else if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") {
      yield { type: "text", index: event.index, text: event.delta.text };
    } else if (event.delta.type === "input_json_delta") {
      const tool = state.toolIdsByIndex.get(event.index);
      if (tool !== undefined) {
        state.toolArgumentsByIndex.set(
          event.index,
          (state.toolArgumentsByIndex.get(event.index) ?? "") + event.delta.partial_json,
        );
        yield {
          type: "tool_call",
          index: event.index,
          callId: tool.callId,
          arguments: event.delta.partial_json,
        };
      }
    }
  } else if (event.type === "content_block_stop") {
    const tool = state.toolIdsByIndex.get(event.index);
    if (tool !== undefined && state.toolArgumentsByIndex.get(event.index) === "") {
      yield {
        type: "tool_call",
        index: event.index,
        callId: tool.callId,
        arguments: "{}",
      };
    }
  }
}
