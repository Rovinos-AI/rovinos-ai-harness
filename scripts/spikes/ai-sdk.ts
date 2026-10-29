// SPDX-License-Identifier: Apache-2.0
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  AiStoredMessageSchema,
  AnthropicBlockSchema,
  AnthropicRequestSchema,
  OpenAIResponseSchema,
  OpenAIRequestSchema,
  ToolInputSchema,
  fixtureFetch,
  rawMultiTurnResponse,
  responseFixtures,
  type CapturedRequest,
  type JsonRecord,
  type Provider,
  type Scenario,
  type ScenarioResult,
} from "./model-adapter-fixtures.ts";

interface AnthropicThinkingOptions {
  readonly providerOptions: {
    readonly anthropic: {
      readonly thinking: { readonly type: "enabled"; readonly budgetTokens: number };
    };
  };
}

const lookupTools = {
  lookup: tool({
    description: "Look up a synthetic record.",
    inputSchema: ToolInputSchema,
    execute: () => Promise.resolve("synthetic tool result"),
  }),
};

/** Runs the text, forced-tool, or stored-JSON scenario through the AI SDK. */
export async function runAiSdk(
  providerName: Provider,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const requests: CapturedRequest[] = [];
  const fetch = fixtureFetch(responseFixtures(providerName, scenario), requests);
  const provider =
    providerName === "anthropic"
      ? createAnthropic({ apiKey: "synthetic-spike-key", fetch })
      : createOpenAI({ apiKey: "synthetic-spike-key", fetch });
  const model =
    providerName === "anthropic"
      ? provider("claude-spike-model")
      : provider.chat("openai-spike-model");

  if (scenario === "plain-text") {
    return aiPlainText(model);
  }
  if (scenario === "forced-tool") {
    return aiForcedTool(model);
  }

  const thinkingOptions: AnthropicThinkingOptions | undefined =
    providerName === "anthropic"
      ? { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } } }
      : undefined;
  return aiMultiTurn(providerName, model, requests, thinkingOptions);
}

async function aiPlainText(model: LanguageModel): Promise<ScenarioResult> {
  const response = await generateText({
    model,
    prompt: "synthetic prompt",
    maxRetries: 0,
    maxOutputTokens: 32,
  });
  return { passed: response.text === "synthetic plain response", rawBlobRoundTrip: undefined };
}

async function aiForcedTool(
  model: LanguageModel,
): Promise<ScenarioResult> {
  const response = await generateText({
    model,
    prompt: "synthetic prompt",
    tools: lookupTools,
    toolChoice: { type: "tool", toolName: "lookup" },
    maxRetries: 0,
    maxOutputTokens: 32,
    stopWhen: stepCountIs(1),
  });
  return {
    passed: response.toolCalls.some((call) => call.toolName === "lookup"),
    rawBlobRoundTrip: undefined,
  };
}

async function aiMultiTurn(
  providerName: Provider,
  model: LanguageModel,
  requests: CapturedRequest[],
  thinkingOptions: AnthropicThinkingOptions | undefined,
): Promise<ScenarioResult> {
  const providerOptions = thinkingOptions ?? {};
  const first = await generateText({
    model,
    prompt: "synthetic prompt",
    tools: lookupTools,
    maxRetries: 0,
    maxOutputTokens: 32,
    stopWhen: stepCountIs(1),
    ...providerOptions,
  });
  const storedMessages = parseJson(
    z.array(AiStoredMessageSchema),
    JSON.stringify(first.responseMessages),
  ).map(toModelMessage);
  const toolCall = first.toolCalls.find((call) => call.toolName === "lookup");
  if (toolCall === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }

  const followUp = await generateText({
    model,
    messages: [{ role: "user", content: "synthetic prompt" }, ...storedMessages],
    tools: lookupTools,
    maxRetries: 0,
    maxOutputTokens: 32,
    stopWhen: stepCountIs(1),
    ...providerOptions,
  });
  const secondRequest = requests[1];
  if (secondRequest === undefined) {
    return { passed: false, rawBlobRoundTrip: false };
  }
  const rawResponse = rawMultiTurnResponse(providerName);
  const fidelity =
    providerName === "anthropic"
      ? hasAnthropicRawRoundTrip(secondRequest.body, rawResponse)
      : hasOpenAIRawRoundTrip(secondRequest.body, rawResponse);

  return {
    passed: followUp.text === "synthetic follow-up",
    rawBlobRoundTrip: fidelity,
  };
}

function toModelMessage(message: z.infer<typeof AiStoredMessageSchema>): ModelMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content.map((part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
      })),
    };
  }

  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "reasoning") {
        return {
          type: "reasoning",
          text: part.text,
          ...(part.providerOptions === undefined
            ? {}
            : { providerOptions: part.providerOptions }),
        };
      }
      if (part.type === "tool-call") {
        return {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
      }
      return { type: "text", text: part.text };
    }),
  };
}

function hasAnthropicRawRoundTrip(requestBody: JsonRecord, responseBody: JsonRecord): boolean {
  const request = parseJson(AnthropicRequestSchema, JSON.stringify(requestBody));
  const assistantRequest = request.messages.find((message) => message.role === "assistant");
  const response = parseJson(
    z.array(AnthropicBlockSchema),
    JSON.stringify(responseBody.content),
  );
  return (
    Array.isArray(assistantRequest?.content) &&
    JSON.stringify(assistantRequest.content) === JSON.stringify(response)
  );
}

function hasOpenAIRawRoundTrip(requestBody: JsonRecord, responseBody: JsonRecord): boolean {
  const request = parseJson(OpenAIRequestSchema, JSON.stringify(requestBody));
  const assistantRequest = request.messages.find((message) => message.role === "assistant");
  const response = parseJson(OpenAIResponseSchema, JSON.stringify(responseBody));
  const rawMessage = response.choices[0]?.message;
  return rawMessage !== undefined && JSON.stringify(assistantRequest) === JSON.stringify(rawMessage);
}
