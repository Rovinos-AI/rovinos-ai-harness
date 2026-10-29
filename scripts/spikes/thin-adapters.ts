// SPDX-License-Identifier: Apache-2.0
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { parseJson } from "@rovinos/schemas";
import {
  AnthropicRequestSchema,
  OpenAIRequestSchema,
  StoredAnthropicAssistantSchema,
  StoredOpenAIAssistantSchema,
  ToolJsonSchema,
  responseFixtures,
  fixtureFetch,
  type CapturedRequest,
  type Scenario,
  type ScenarioResult,
} from "./model-adapter-fixtures.ts";

const anthropicTool = {
  name: "lookup",
  description: "Look up a synthetic record.",
  input_schema: ToolJsonSchema,
};

const openaiTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look up a synthetic record.",
    parameters: ToolJsonSchema,
  },
};

/** Runs one scenario through the official provider SDK selected by provider. */
export async function runThinScenario(
  provider: "anthropic" | "openai",
  scenario: Scenario,
): Promise<ScenarioResult> {
  const requests: CapturedRequest[] = [];
  const fetch = fixtureFetch(responseFixtures(provider, scenario), requests);
  if (provider === "anthropic") {
    const sdk = new Anthropic({ apiKey: "synthetic-spike-key", maxRetries: 0, fetch });
    if (scenario === "plain-text") {
      return thinAnthropicPlainText(sdk);
    }
    if (scenario === "forced-tool") {
      return thinAnthropicForcedTool(sdk);
    }
    return thinAnthropicMultiTurn(sdk, requests);
  }

  const sdk = new OpenAI({ apiKey: "synthetic-spike-key", maxRetries: 0, fetch });
  if (scenario === "plain-text") {
    return thinOpenAIPlainText(sdk);
  }
  if (scenario === "forced-tool") {
    return thinOpenAIForcedTool(sdk);
  }
  return thinOpenAIMultiTurn(sdk, requests);
}

async function thinAnthropicPlainText(sdk: Anthropic): Promise<ScenarioResult> {
  const response = await sdk.messages.create({
    model: "claude-spike-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "synthetic prompt" }],
  });
  return { passed: response.content[0]?.type === "text", rawBlobRoundTrip: undefined };
}

async function thinAnthropicForcedTool(sdk: Anthropic): Promise<ScenarioResult> {
  const response = await sdk.messages.create({
    model: "claude-spike-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "synthetic prompt" }],
    tools: [anthropicTool],
    tool_choice: { type: "tool", name: "lookup" },
  });
  return {
    passed: response.content.some((part) => part.type === "tool_use"),
    rawBlobRoundTrip: undefined,
  };
}

async function thinAnthropicMultiTurn(
  sdk: Anthropic,
  requests: CapturedRequest[],
): Promise<ScenarioResult> {
  const response = await sdk.messages.create({
    model: "claude-spike-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "synthetic prompt" }],
    tools: [anthropicTool],
  });
  const assistantMessage = parseJson(
    StoredAnthropicAssistantSchema,
    JSON.stringify({ role: "assistant", content: response.content }),
  );
  const toolUse = assistantMessage.content.find((part) => part.type === "tool_use");
  if (toolUse?.type !== "tool_use") {
    return { passed: false, rawBlobRoundTrip: false };
  }

  const messages: MessageParam[] = [
    { role: "user", content: "synthetic prompt" },
    assistantMessage,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "synthetic tool result",
        },
      ],
    },
  ];
  const followUp = await sdk.messages.create({
    model: "claude-spike-model",
    max_tokens: 32,
    messages,
  });
  const secondRequest = requests[1];
  if (secondRequest === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }
  const request = parseJson(AnthropicRequestSchema, JSON.stringify(secondRequest.body));
  const assistantRequest = request.messages.find((message) => message.role === "assistant");
  const fidelity =
    Array.isArray(assistantRequest?.content) &&
    JSON.stringify(assistantRequest.content) === JSON.stringify(assistantMessage.content);

  return {
    passed: followUp.content.some((part) => part.type === "text"),
    rawBlobRoundTrip: fidelity,
  };
}

async function thinOpenAIPlainText(sdk: OpenAI): Promise<ScenarioResult> {
  const response = await sdk.chat.completions.create({
    model: "openai-spike-model",
    messages: [{ role: "user", content: "synthetic prompt" }],
  });
  return {
    passed: response.choices[0]?.message.content === "synthetic plain response",
    rawBlobRoundTrip: undefined,
  };
}

async function thinOpenAIForcedTool(sdk: OpenAI): Promise<ScenarioResult> {
  const response = await sdk.chat.completions.create({
    model: "openai-spike-model",
    messages: [{ role: "user", content: "synthetic prompt" }],
    tools: [openaiTool],
    tool_choice: { type: "function", function: { name: "lookup" } },
  });
  return {
    passed:
      response.choices[0]?.message.tool_calls?.some((call) => call.type === "function") ?? false,
    rawBlobRoundTrip: undefined,
  };
}

async function thinOpenAIMultiTurn(
  sdk: OpenAI,
  requests: CapturedRequest[],
): Promise<ScenarioResult> {
  const response = await sdk.chat.completions.create({
    model: "openai-spike-model",
    messages: [{ role: "user", content: "synthetic prompt" }],
    tools: [openaiTool],
  });
  const firstMessage = response.choices[0]?.message;
  if (firstMessage === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }
  const assistantMessage = parseJson(
    StoredOpenAIAssistantSchema,
    JSON.stringify(firstMessage),
  );
  const toolCall = assistantMessage.tool_calls[0];
  if (toolCall === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "user", content: "synthetic prompt" },
    assistantMessage,
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: "synthetic tool result",
    },
  ];
  const followUp = await sdk.chat.completions.create({
    model: "openai-spike-model",
    messages,
  });
  const secondRequest = requests[1];
  if (secondRequest === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }
  const request = parseJson(OpenAIRequestSchema, JSON.stringify(secondRequest.body));
  const assistantRequest = request.messages.find((message) => message.role === "assistant");

  return {
    passed: followUp.choices[0]?.message.content === "synthetic follow-up",
    rawBlobRoundTrip: JSON.stringify(assistantRequest) === JSON.stringify(assistantMessage),
  };
}
