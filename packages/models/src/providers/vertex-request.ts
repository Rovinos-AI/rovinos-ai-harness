// SPDX-License-Identifier: Apache-2.0
import {
  FunctionCallingConfigMode,
  type Content,
  type GenerateContentConfig,
  type Part as VertexPart,
} from "@google/genai";
import { Code, JsonValue, type ModelRequest, type Part } from "@rovinos/schemas";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { lowerForProvider } from "../json-schema.js";

const VertexFunctionCallSchema = z
  .object({
    id: z.string().optional(),
    name: Code,
  })
  .strict();

const VertexOpaquePartSchema = z.custom<VertexPart>(
  (part) => typeof part === "object" && part !== null && !Array.isArray(part),
);

const VertexContentSchema = z.looseObject({
  parts: z.array(VertexOpaquePartSchema),
  role: z.string().optional(),
});

export const VertexOpaqueBlobSchema = z
  .object({
    content: VertexContentSchema,
    droppedSchemaKeywords: z.array(Code),
    functionCalls: z.record(z.string(), VertexFunctionCallSchema),
  })
  .strict();

/** Provider call identifier retained so subsequent tool results match the raw call. */
export type VertexFunctionCall = z.infer<typeof VertexFunctionCallSchema>;
type VertexCode = z.infer<typeof Code>;

interface BuiltContents {
  readonly contents: Content[];
  readonly systemInstruction?: Content;
}

interface BuildContentsState {
  readonly contents: Content[];
  readonly systemParts: VertexPart[];
  lastToolContent: Content | undefined;
}

/** Parses an adapter-owned opaque response, rejecting malformed replay data. */
export function readVertexOpaque(blob: JsonValue): z.infer<typeof VertexOpaqueBlobSchema> {
  const parsed = VertexOpaqueBlobSchema.safeParse(blob);
  if (!parsed.success) {
    throw new ProviderError("provider_bad_request");
  }
  return parsed.data;
}

function readJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderError("provider_bad_request");
  }
  return value;
}

function matchingOpaque(message: ModelRequest["messages"][number], provider: string) {
  return message.parts.find((part) => part.type === "opaque" && part.provider === provider);
}

function sameNormalizedParts(
  message: ModelRequest["messages"][number],
  opaque: z.infer<typeof VertexOpaqueBlobSchema>,
): boolean {
  const callEntries = Object.entries(opaque.functionCalls);
  const usedCallIds = new Set<string>();
  const rawParts: Part[] = [];

  for (const rawPart of opaque.content.parts) {
    if (typeof rawPart.text === "string" && rawPart.thought !== true) {
      rawParts.push({ type: "text", text: rawPart.text });
    }
    const call = rawPart.functionCall;
    if (call === undefined) {
      continue;
    }
    if (call.name === undefined) {
      return false;
    }
    const entry = callEntries.find(
      ([callId, metadata]) =>
        !usedCallIds.has(callId) &&
        metadata.name === call.name &&
        (metadata.id === undefined || metadata.id === call.id),
    );
    if (entry === undefined) {
      return false;
    }
    usedCallIds.add(entry[0]);
    try {
      rawParts.push({
        type: "tool_call",
        callId: entry[0],
        toolId: Code.parse(call.name),
        args: JsonValue.parse(call.args ?? {}),
      });
    } catch {
      return false;
    }
  }

  const normalizedParts = message.parts.filter((part) => part.type !== "opaque");
  return (
    usedCallIds.size === callEntries.length &&
    JSON.stringify(rawParts) === JSON.stringify(normalizedParts)
  );
}

function findFunctionCall(
  request: ModelRequest,
  messageIndex: number,
  callId: string,
  provider: string,
): VertexFunctionCall | undefined {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const opaque = matchingOpaque(message, provider);
    if (opaque?.type === "opaque") {
      const functionCall = readVertexOpaque(opaque.blob).functionCalls[callId];
      if (functionCall !== undefined) {
        return functionCall;
      }
    }
    const call = message.parts.find((part) => part.type === "tool_call" && part.callId === callId);
    if (call?.type === "tool_call") {
      return { name: call.toolId };
    }
  }
  return undefined;
}

function toolResultPart(
  request: ModelRequest,
  messageIndex: number,
  part: Extract<Part, { type: "tool_result" }>,
  provider: string,
): VertexPart {
  const functionCall = findFunctionCall(request, messageIndex, part.callId, provider);
  if (functionCall === undefined) {
    throw new ProviderError("provider_bad_request");
  }
  const result = JsonValue.parse(part.result);
  let response: Record<string, JsonValue>;
  if (part.isError) {
    response = { error: result };
  } else if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    response = result;
  } else {
    response = { result };
  }
  return {
    functionResponse: {
      name: functionCall.name,
      response,
      ...(functionCall.id === undefined ? {} : { id: functionCall.id }),
    },
  };
}

function replayableContent(
  message: ModelRequest["messages"][number],
  provider: string,
): Content | undefined {
  const opaque = matchingOpaque(message, provider);
  if (opaque?.type !== "opaque") {
    return undefined;
  }
  const parsed = readVertexOpaque(opaque.blob);
  if (!sameNormalizedParts(message, parsed)) {
    return undefined;
  }
  return {
    parts: parsed.content.parts,
    ...(parsed.content.role === undefined ? {} : { role: parsed.content.role }),
  };
}

function appendSystemParts(message: ModelRequest["messages"][number], parts: VertexPart[]): void {
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    }
  }
}

function buildMessageParts(
  request: ModelRequest,
  messageIndex: number,
  provider: string,
): VertexPart[] {
  const message = request.messages[messageIndex];
  if (message === undefined) {
    return [];
  }
  const parts: VertexPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    } else if (part.type === "tool_call") {
      parts.push({
        functionCall: {
          name: part.toolId,
          args: readJsonObject(JsonValue.parse(part.args)),
        },
      });
    } else if (part.type === "tool_result") {
      parts.push(toolResultPart(request, messageIndex, part, provider));
    }
  }
  return parts;
}

function appendMessageContent(
  state: BuildContentsState,
  message: ModelRequest["messages"][number],
  parts: VertexPart[],
): Content | undefined {
  if (parts.length === 0) {
    return message.role === "tool" ? state.lastToolContent : undefined;
  }
  if (message.role === "tool" && state.lastToolContent?.parts !== undefined) {
    state.lastToolContent.parts.push(...parts);
    return state.lastToolContent;
  }
  const content: Content = {
    role: message.role === "assistant" ? "model" : "user",
    parts,
  };
  state.contents.push(content);
  return message.role === "tool" ? content : undefined;
}

/** Converts normalized messages to Vertex content, replaying unchanged opaque turns. */
export function buildContents(request: ModelRequest, provider: string): BuiltContents {
  const state: BuildContentsState = {
    contents: [],
    systemParts: [],
    lastToolContent: undefined,
  };
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      state.lastToolContent = undefined;
      appendSystemParts(message, state.systemParts);
      continue;
    }
    const replayed =
      message.role === "assistant" ? replayableContent(message, provider) : undefined;
    if (replayed !== undefined) {
      state.lastToolContent = undefined;
      state.contents.push(replayed);
      continue;
    }
    state.lastToolContent = appendMessageContent(
      state,
      message,
      buildMessageParts(request, index, provider),
    );
  }
  return {
    contents: state.contents,
    ...(state.systemParts.length === 0 ? {} : { systemInstruction: { parts: state.systemParts } }),
  };
}

function forcedToolFor(request: ModelRequest): string | undefined {
  if (typeof request.toolChoice === "object") {
    return request.toolChoice.forced;
  }
  return undefined;
}

function lowerTools(
  request: ModelRequest,
  droppedSchemaKeywords: Set<VertexCode>,
): GenerateContentConfig["tools"] {
  if (request.tools === undefined || request.toolChoice === "none") {
    return undefined;
  }
  return request.tools.map((tool) => {
    const lowered = lowerForProvider(readJsonObject(tool.inputSchema), "vertex");
    lowered.dropped.forEach((keyword) => droppedSchemaKeywords.add(keyword));
    return {
      functionDeclarations: [
        {
          name: tool.toolId,
          description: tool.description,
          parametersJsonSchema: lowered.schema,
        },
      ],
    };
  });
}

function validateForcedTool(request: ModelRequest, forcedTool: string | undefined): void {
  if (
    forcedTool !== undefined &&
    !(request.tools ?? []).some((tool) => tool.toolId === forcedTool)
  ) {
    throw new ProviderError("provider_bad_request");
  }
}

function toolCallingConfig(
  request: ModelRequest,
  tools: GenerateContentConfig["tools"],
  forcedTool: string | undefined,
): Pick<GenerateContentConfig, "tools" | "toolConfig"> {
  if (tools === undefined || tools.length === 0 || request.toolChoice === "none") {
    return {};
  }
  return {
    tools,
    toolConfig: {
      functionCallingConfig: {
        mode:
          forcedTool === undefined ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.ANY,
        ...(forcedTool === undefined ? {} : { allowedFunctionNames: [forcedTool] }),
      },
    },
  };
}

/** Converts tools, output constraints, and cancellation into Vertex generation config. */
export function buildConfig(
  request: ModelRequest,
  signal: AbortSignal,
  maxOutputTokens: number,
): { readonly config: GenerateContentConfig; readonly droppedSchemaKeywords: VertexCode[] } {
  const droppedSchemaKeywords = new Set<VertexCode>();
  const forcedTool = forcedToolFor(request);
  validateForcedTool(request, forcedTool);
  const tools = lowerTools(request, droppedSchemaKeywords);
  const outputSchema =
    request.output === undefined
      ? undefined
      : lowerForProvider(readJsonObject(request.output.schema), "vertex");
  outputSchema?.dropped.forEach((keyword) => droppedSchemaKeywords.add(keyword));
  const toolConfig = toolCallingConfig(request, tools, forcedTool);
  return {
    config: {
      maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      abortSignal: signal,
      ...toolConfig,
      ...(outputSchema === undefined
        ? {}
        : { responseMimeType: "application/json", responseJsonSchema: outputSchema.schema }),
    },
    droppedSchemaKeywords: [...droppedSchemaKeywords].sort(),
  };
}
