// SPDX-License-Identifier: Apache-2.0
import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type Part as VertexPart,
} from "@google/genai";
import {
  Code,
  JsonValue,
  type Capabilities,
  type ModelRequest,
  type Part,
} from "@harness/schemas";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { lowerForProvider } from "../json-schema.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

const VertexFunctionCallSchema = z
  .object({
    id: z.string().optional(),
    name: Code,
  })
  .strict();

const VertexContentSchema = z
  .object({
    parts: z.array(JsonValue),
    role: z.string().optional(),
  })
  .passthrough();

const VertexOpaqueBlobSchema = z
  .object({
    content: VertexContentSchema,
    droppedSchemaKeywords: z.array(Code),
    functionCalls: z.record(z.string(), VertexFunctionCallSchema),
  })
  .strict();

type VertexFunctionCall = z.infer<typeof VertexFunctionCallSchema>;

function readJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderError("provider_bad_request");
  }
  return value;
}

/** Options for a Vertex AI Gemini adapter. ADC is used unless SDK auth options are supplied. */
export interface VertexAdapterOptions {
  /** Google Cloud project containing the Vertex AI model. */
  readonly project: string;
  /** Vertex AI location, such as `us-central1`. */
  readonly location: string;
  /** Provider code used to identify opaque response parts. */
  readonly provider?: z.infer<typeof Code>;
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
  /** SDK HTTP options, including transport injection for tests or a compatible endpoint. */
  readonly httpOptions?: GoogleGenAIOptions["httpOptions"];
  /** Optional Google Auth configuration; default credentials are discovered through ADC. */
  readonly googleAuthOptions?: GoogleGenAIOptions["googleAuthOptions"];
}

function readVertexOpaque(blob: JsonValue): z.infer<typeof VertexOpaqueBlobSchema> {
  const parsed = VertexOpaqueBlobSchema.safeParse(blob);
  if (!parsed.success) {
    throw new ProviderError("provider_bad_request");
  }
  return parsed.data;
}

function matchingOpaque(message: ModelRequest["messages"][number], provider: string) {
  return message.parts.find((part) => part.type === "opaque" && part.provider === provider);
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
  const response = part.isError
    ? { error: result }
    : typeof result === "object" && result !== null && !Array.isArray(result)
      ? result
      : { result };
  return {
    functionResponse: {
      name: functionCall.name,
      response,
      ...(functionCall.id === undefined ? {} : { id: functionCall.id }),
    },
  };
}

function buildContents(request: ModelRequest, provider: string): {
  readonly contents: Content[];
  readonly systemInstruction?: Content;
} {
  const contents: Content[] = [];
  const systemParts: VertexPart[] = [];

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      for (const part of message.parts) {
        if (part.type === "text") {
          systemParts.push({ text: part.text });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const opaque = matchingOpaque(message, provider);
      if (opaque?.type === "opaque") {
        const raw = readVertexOpaque(opaque.blob).content;
        // The opaque JSON was shape-checked above; SDK fields remain open for forward-compatible parts.
        contents.push(raw as Content);
        continue;
      }
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
        parts.push(toolResultPart(request, index, part, provider));
      }
    }
    if (parts.length > 0) {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  return {
    contents,
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
  };
}

function buildConfig(
  request: ModelRequest,
  signal: AbortSignal,
  maxOutputTokens: number,
): { readonly config: GenerateContentConfig; readonly droppedSchemaKeywords: z.infer<typeof Code>[] } {
  const droppedSchemaKeywords = new Set<z.infer<typeof Code>>();
  const tools =
    request.tools === undefined || request.toolChoice === "none"
      ? undefined
      : request.tools.map((tool) => {
          const lowered = lowerForProvider(readJsonObject(tool.inputSchema), "vertex");
          lowered.dropped.forEach((keyword) => droppedSchemaKeywords.add(keyword));
          return {
            name: tool.toolId,
            description: tool.description,
            parametersJsonSchema: lowered.schema,
          };
        });
  const outputSchema =
    request.output === undefined
      ? undefined
      : lowerForProvider(readJsonObject(request.output.schema), "vertex");
  outputSchema?.dropped.forEach((keyword) => droppedSchemaKeywords.add(keyword));

  const mode =
    request.toolChoice === "none"
      ? FunctionCallingConfigMode.NONE
      : request.toolChoice === undefined || request.toolChoice === "auto"
        ? FunctionCallingConfigMode.AUTO
        : FunctionCallingConfigMode.ANY;
  const forcedTool =
    typeof request.toolChoice === "object" ? request.toolChoice.forced : undefined;

  return {
    config: {
      maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      abortSignal: signal,
      ...(tools === undefined || tools.length === 0
        ? {}
        : { tools: [{ functionDeclarations: tools }] }),
      ...(request.tools === undefined && request.toolChoice === undefined
        ? {}
        : {
            toolConfig: {
              functionCallingConfig: {
                mode,
                ...(forcedTool === undefined ? {} : { allowedFunctionNames: [forcedTool] }),
              },
            },
          }),
      ...(outputSchema === undefined
        ? {}
        : { responseMimeType: "application/json", responseJsonSchema: outputSchema.schema }),
    },
    droppedSchemaKeywords: [...droppedSchemaKeywords].sort(),
  };
}

function mapFinishReason(response: GenerateContentResponse): string {
  if (response.promptFeedback?.blockReason !== undefined) {
    return "provider_content_filtered";
  }
  const reason = response.candidates?.[0]?.finishReason;
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "provider_content_filtered";
    default:
      return "other";
  }
}

function mapResponse(
  response: GenerateContentResponse,
  context: ProviderContext,
  provider: string,
  startedAt: number,
  droppedSchemaKeywords: z.infer<typeof Code>[],
): ProviderResult {
  const candidate = response.candidates?.[0];
  const content = candidate?.content;
  const parts: Part[] = [];
  const functionCalls: Record<string, VertexFunctionCall> = {};

  for (const part of content?.parts ?? []) {
    if (part.text !== undefined && part.thought !== true) {
      parts.push({ type: "text", text: part.text });
    }
    const functionCall = part.functionCall;
    if (functionCall?.name !== undefined) {
      try {
        const callId = context.ids.next();
        const toolId = Code.parse(functionCall.name);
        const args = JsonValue.parse(functionCall.args ?? {});
        functionCalls[callId] = {
          name: toolId,
          ...(functionCall.id === undefined ? {} : { id: functionCall.id }),
        };
        parts.push({ type: "tool_call", callId, toolId, args });
      } catch {
        throw new ProviderError("provider_unknown");
      }
    }
  }

  if (content !== undefined) {
    parts.push({
      type: "opaque",
      provider,
      blob: JsonValue.parse({
        content,
        droppedSchemaKeywords,
        functionCalls,
      }),
    });
  }

  const usage = response.usageMetadata;
  return {
    parts,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      ...(usage?.cachedContentTokenCount === undefined
        ? {}
        : { cacheReadTokens: usage.cachedContentTokenCount }),
    },
    finishReason: Code.parse(mapFinishReason(response)),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
}

function mapError(error: unknown, signal: AbortSignal): never {
  if (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    throw new ProviderError("provider_timeout");
  }
  if (!(error instanceof ApiError)) {
    throw new ProviderError("provider_unknown");
  }
  if (error.status === 429) {
    throw new ProviderError("provider_rate_limited", { status: error.status });
  }
  if (error.status === 401 || error.status === 403) {
    throw new ProviderError("provider_auth", { status: error.status });
  }
  if (error.status === 408 || error.status === 504) {
    throw new ProviderError("provider_timeout", { status: error.status });
  }
  if (error.status === 400) {
    throw new ProviderError("provider_bad_request", { status: error.status });
  }
  if (error.status >= 500) {
    throw new ProviderError("provider_unavailable", { status: error.status });
  }
  throw new ProviderError("provider_unknown", { status: error.status });
}

/** Vertex AI adapter for Gemini models using Application Default Credentials. */
export class VertexAdapter implements ProviderAdapter {
  readonly provider: z.infer<typeof Code>;
  readonly kind = "vertex" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: GoogleGenAI;

  /**
   * Creates a Vertex AI client with SDK retries disabled.
   *
   * @param options - Google Cloud project, location, and optional SDK transport configuration.
   */
  constructor(options: VertexAdapterOptions) {
    this.provider = options.provider ?? "vertex";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.capabilities = options.capabilities ?? {};
    const retryOptions = options.httpOptions?.retryOptions;
    this.client = new GoogleGenAI({
      vertexai: true,
      project: options.project,
      location: options.location,
      ...(options.googleAuthOptions === undefined
        ? {}
        : { googleAuthOptions: options.googleAuthOptions }),
      httpOptions: {
        ...options.httpOptions,
        retryOptions: { ...retryOptions, attempts: 1 },
      },
    });
  }

  /** @inheritdoc */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    const builtContents = buildContents(request, this.provider);
    const builtConfig = buildConfig(request, context.signal, this.maxOutputTokens);
    try {
      const response = await this.client.models.generateContent({
        model: request.model.model,
        contents: builtContents.contents,
        config: {
          ...builtConfig.config,
          ...(builtContents.systemInstruction === undefined
            ? {}
            : { systemInstruction: builtContents.systemInstruction }),
        },
      });
      return mapResponse(
        response,
        context,
        this.provider,
        startedAt,
        builtConfig.droppedSchemaKeywords,
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      mapError(error, context.signal);
    }
  }
}
