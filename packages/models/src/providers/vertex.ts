// SPDX-License-Identifier: Apache-2.0
import { GoogleGenAI } from "@google/genai";
import type { GoogleGenAIOptions } from "@google/genai";
import type { Capabilities, ModelRequest } from "@harness/schemas";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import { mapVertexError, VertexHttpError } from "./vertex-errors.js";
import { buildConfig, buildContents } from "./vertex-request.js";
import { mapVertexResponse } from "./vertex-response.js";

const VertexAdapterValidationSchema = z.looseObject({
  project: z
    .string()
    .min(1)
    .regex(/^[\w.:-]+$/),
  location: z.string().regex(/^[a-z0-9-]+$/),
  httpOptions: z
    .looseObject({
      baseUrl: z
        .url()
        .refine((value) => new URL(value).protocol === "https:")
        .optional(),
    })
    .optional(),
});

/** Options for a Vertex AI Gemini adapter. ADC is used unless SDK auth options are supplied. */
export interface VertexAdapterOptions {
  /** Google Cloud project containing the Vertex AI model. */
  readonly project: string;
  /** Vertex AI location, such as `us-central1`. */
  readonly location: string;
  /** Provider code used to identify opaque response parts. */
  readonly provider?: ProviderAdapter["provider"];
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
  /** SDK HTTP options, including transport injection for tests or a compatible endpoint. */
  readonly httpOptions?: GoogleGenAIOptions["httpOptions"];
  /** Optional Google Auth configuration; default credentials are discovered through ADC. */
  readonly googleAuthOptions?: GoogleGenAIOptions["googleAuthOptions"];
}

function awaitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ProviderError("provider_timeout"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
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
          reject(error instanceof Error ? error : new ProviderError("provider_unknown"));
        },
      );
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new ProviderError("provider_unknown"));
    }
  });
}

/** Vertex AI adapter for Gemini models using Application Default Credentials. */
export class VertexAdapter implements ProviderAdapter {
  readonly provider: ProviderAdapter["provider"];
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
      return mapVertexResponse({
        response,
        context,
        provider: this.provider,
        startedAt,
        droppedSchemaKeywords: builtConfig.droppedSchemaKeywords,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw mapVertexError(error, context.signal, context.clock.now());
    }
  }
}
