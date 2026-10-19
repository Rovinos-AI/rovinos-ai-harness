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
  parseJson,
  type Capabilities,
  type ModelRequest,
  type Part,
} from "@harness/schemas";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { lowerForProvider } from "../json-schema.js";
import { retryAfterMs } from "./retry-after.js";
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

const VertexAdapterValidationSchema = z
  .object({
    project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    location: z.string().regex(/^[a-z0-9-]+$/),
    httpOptions: z
      .object({
        baseUrl: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:")
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const SAFETY_BLOCKS = new Set([
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "SAFETY",
  "SPII",
]);

class VertexHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfter: string | null,
  ) {
    super("vertex_http_error");
    this.name = "VertexHttpError";
  }
}

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

function sameNormalizedParts(
  message: ModelRequest["messages"][number],
  opaque: z.infer<typeof VertexOpaqueBlobSchema>,
): boolean {
  const callEntries = Object.entries(opaque.functionCalls);
  const usedCallIds = new Set<string>();
  const rawParts: Part[] = [];

  for (const rawPart of opaque.content.parts) {
    if (typeof rawPart !== "object" || rawPart === null || Array.isArray(rawPart)) {
      continue;
    }
    if (typeof rawPart.text === "string" && rawPart.thought !== true) {
      rawParts.push({ type: "text", text: rawPart.text });
    }
    if (
      typeof rawPart.functionCall !== "object" ||
      rawPart.functionCall === null ||
      Array.isArray(rawPart.functionCall)
    ) {
      continue;
    }
    const call = rawPart.functionCall;
    if (typeof call.name !== "string") {
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
  let lastToolContent: Content | undefined;

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      lastToolContent = undefined;
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
        const parsed = readVertexOpaque(opaque.blob);
        if (sameNormalizedParts(message, parsed)) {
          lastToolContent = undefined;
          // SDK fields remain open for forward-compatible parts after shape validation.
          contents.push(parsed.content as Content);
          continue;
        }
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
      if (message.role === "tool" && lastToolContent?.parts !== undefined) {
        lastToolContent.parts.push(...parts);
      } else {
        const content: Content = {
          role: message.role === "assistant" ? "model" : "user",
          parts,
        };
        contents.push(content);
        lastToolContent = message.role === "tool" ? content : undefined;
      }
    } else if (message.role !== "tool") {
      lastToolContent = undefined;
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
  const forcedTool =
    typeof request.toolChoice === "object" ? request.toolChoice.forced : undefined;
  if (
    forcedTool !== undefined &&
    !(request.tools ?? []).some((tool) => tool.toolId === forcedTool)
  ) {
    throw new ProviderError("provider_bad_request");
  }
  const outputSchema =
    request.output === undefined
      ? undefined
      : lowerForProvider(readJsonObject(request.output.schema), "vertex");
  outputSchema?.dropped.forEach((keyword) => droppedSchemaKeywords.add(keyword));

  const mode =
    forcedTool === undefined ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.ANY;
  const hasTools = tools !== undefined && tools.length > 0 && request.toolChoice !== "none";

  return {
    config: {
      maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      abortSignal: signal,
      ...(!hasTools
        ? {}
        : { tools: [{ functionDeclarations: tools }] }),
      ...(!hasTools
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
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "provider_content_filtered";
    case "MALFORMED_FUNCTION_CALL":
      return "tool_args_invalid";
    case "UNEXPECTED_TOOL_CALL":
      return "other";
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
  const mappedFinishReason = mapFinishReason(response);
  const finishReason =
    parts.some((part) => part.type === "tool_call") &&
    mappedFinishReason !== "provider_content_filtered" &&
    mappedFinishReason !== "tool_args_invalid"
      ? "tool_calls"
      : mappedFinishReason;
  return {
    parts,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens:
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      ...(usage?.cachedContentTokenCount === undefined
        ? {}
        : { cacheReadTokens: usage.cachedContentTokenCount }),
    },
    finishReason: Code.parse(finishReason),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
}

function containsSafetyBlock(value: JsonValue): boolean {
  if (typeof value === "string") {
    return SAFETY_BLOCKS.has(value.toUpperCase());
  }
  if (Array.isArray(value)) {
    return value.some(containsSafetyBlock);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsSafetyBlock);
  }
  return false;
}

function parsedErrorBody(body: string): JsonValue | undefined {
  try {
    return parseJson(JsonValue, body);
  } catch {
    return undefined;
  }
}

function retryInfoMs(value: JsonValue): number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const delay = retryInfoMs(entry);
      if (delay !== undefined) {
        return delay;
      }
    }
  } else if (typeof value === "object" && value !== null) {
    const retryDelay = value.retryDelay;
    if (typeof retryDelay === "string") {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay);
      if (match?.[1] !== undefined) {
        return Number(match[1]) * 1_000;
      }
    }
    for (const child of Object.values(value)) {
      const delay = retryInfoMs(child);
      if (delay !== undefined) {
        return delay;
      }
    }
  }
  return undefined;
}

function mapError(error: unknown, signal: AbortSignal, nowMs: number): never {
  if (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    throw new ProviderError("provider_timeout");
  }
  if (error instanceof VertexHttpError) {
    const body = parsedErrorBody(error.body);
    if (error.status === 400 && body !== undefined && containsSafetyBlock(body)) {
      throw new ProviderError("provider_content_filtered", { status: error.status });
    }
    if (error.status === 429) {
      const delay =
        retryAfterMs(error.retryAfter, nowMs) ??
        (body === undefined ? undefined : retryInfoMs(body));
      throw new ProviderError("provider_rate_limited", {
        status: error.status,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    if (error.status === 401 || error.status === 403) {
      throw new ProviderError("provider_auth", { status: error.status });
    }
    if (error.status === 408 || error.status === 504) {
      throw new ProviderError("provider_timeout", { status: error.status });
    }
    if (error.status === 400 || error.status === 404) {
      throw new ProviderError("provider_bad_request", { status: error.status });
    }
    if (error.status >= 500) {
      throw new ProviderError("provider_unavailable", { status: error.status });
    }
    throw new ProviderError("provider_unknown", { status: error.status });
  }
  if (!(error instanceof ApiError)) {
    if (error instanceof Error) {
      const causeCode =
        typeof error.cause === "object" && error.cause !== null && "code" in error.cause
          ? error.cause.code
          : undefined;
      if (
        causeCode === "ECONNRESET" ||
        causeCode === "ECONNREFUSED" ||
        causeCode === "EHOSTUNREACH" ||
        causeCode === "ENETUNREACH" ||
        error.message.toLowerCase().includes("fetch failed")
      ) {
        throw new ProviderError("provider_unavailable");
      }
      if (
        error.name === "GoogleAuthError" ||
        error.message.toLowerCase().includes("default credentials") ||
        error.message.toLowerCase().includes("application default credentials")
      ) {
        throw new ProviderError("provider_auth");
      }
    }
    throw new ProviderError("provider_unknown");
  }
  const body = parsedErrorBody(error.message);
  if (error.status === 400 && body !== undefined && containsSafetyBlock(body)) {
    throw new ProviderError("provider_content_filtered", { status: error.status });
  }
  if (error.status === 429) {
    const delay = body === undefined ? undefined : retryInfoMs(body);
    throw new ProviderError("provider_rate_limited", {
      status: error.status,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (error.status === 401 || error.status === 403) {
    throw new ProviderError("provider_auth", { status: error.status });
  }
  if (error.status === 408 || error.status === 504) {
    throw new ProviderError("provider_timeout", { status: error.status });
  }
  if (error.status === 400 || error.status === 404) {
    throw new ProviderError("provider_bad_request", { status: error.status });
  }
  if (error.status >= 500) {
    throw new ProviderError("provider_unavailable", { status: error.status });
  }
  throw new ProviderError("provider_unknown", { status: error.status });
}

function awaitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ProviderError("provider_timeout"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new ProviderError("provider_timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      operation().then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
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
    VertexAdapterValidationSchema.parse(options);
    this.provider = options.provider ?? "vertex";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.capabilities = options.capabilities ?? {};
    const retryOptions = options.httpOptions?.retryOptions;
    const fetch = options.httpOptions?.fetch ?? globalThis.fetch;
    this.client = new GoogleGenAI({
      vertexai: true,
      project: options.project,
      location: options.location,
      ...(options.googleAuthOptions === undefined
        ? {}
        : { googleAuthOptions: options.googleAuthOptions }),
      httpOptions: {
        ...options.httpOptions,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok) {
            throw new VertexHttpError(
              response.status,
              await response.clone().text(),
              response.headers.get("retry-after"),
            );
          }
          return response;
        },
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
      const response = await awaitWithAbort(
        () =>
          this.client.models.generateContent({
            model: request.model.model,
            contents: builtContents.contents,
            config: {
              ...builtConfig.config,
              ...(builtContents.systemInstruction === undefined
                ? {}
                : { systemInstruction: builtContents.systemInstruction }),
            },
          }),
        context.signal,
      );
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
      mapError(error, context.signal, context.clock.now());
    }
  }
}
