// SPDX-License-Identifier: Apache-2.0
import {
  lookupCapabilities,
  type Capabilities,
  type Code,
  type ModelRequest,
} from "@harness/schemas";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { z } from "zod";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import { ProviderError } from "../errors.js";
import { fromChatResponse, toChatRequest } from "./chat-completions-mapper.js";

const OpenAIErrorMetadataSchema = z.object({
  status: z.number().optional(),
  headers: z.instanceof(Headers).nullish(),
});

/** Secret-value interface accepted at the API-key integration boundary. */
export interface OpenAISecret {
  /** Reveals the API key for the authenticated provider request. */
  reveal(): string;
}

/** OpenAI adapter construction options. */
export interface OpenAIAdapterOptions {
  readonly apiKey: OpenAISecret;
  readonly provider?: Code;
  readonly maxOutputTokens?: number;
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly capabilities?: Partial<Capabilities>;
}

/** OpenAI Chat Completions provider adapter. */
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly protocolProvider = "openai" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: OpenAI;

  /**
   * Creates an OpenAI adapter with SDK retries disabled.
   *
   * @param options - Secret API key, optional injected fetch, base URL, and capability overrides.
   */
  constructor(options: OpenAIAdapterOptions) {
    this.provider = options.provider ?? "openai";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.client = new OpenAI({
      apiKey: options.apiKey.reveal(),
      maxRetries: 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
    this.capabilities = options.capabilities ?? {};
  }

  /** {@inheritDoc ProviderAdapter.complete} */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    const capabilities = lookupCapabilities(
      { ...request.model, provider: this.protocolProvider },
      this.capabilities,
    ).capabilities;
    try {
      const response = await this.client.chat.completions.create(
        toChatRequest(
          request,
          {
            structuredOutput: capabilities.structuredOutput,
            parallelToolCalls: capabilities.parallelToolCalls,
          },
          this.provider,
        ),
        { signal: context.signal },
      );
      const mapped = fromChatResponse(response, context.ids, this.provider);
      return {
        ...mapped,
        latencyMs: Math.max(0, context.clock.now() - startedAt),
      };
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

function retryAfterMs(headers: Headers | null | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function mapStatusError(
  status: number | undefined,
  headers: Headers | null | undefined,
): ProviderError {
  switch (status) {
    case 429: {
      const delay = retryAfterMs(headers);
      return new ProviderError("provider_rate_limited", {
        status,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    case 408:
    case 504:
      return new ProviderError("provider_timeout", { status });
    case 401:
    case 403:
      return new ProviderError("provider_auth", { status });
    case 400:
      return new ProviderError("provider_bad_request", { status });
    case undefined:
      return new ProviderError("provider_unknown");
    default:
      if (status >= 500) {
        return new ProviderError("provider_unavailable", { status });
      }
      return new ProviderError("provider_unknown", { status });
  }
}

function mapOpenAIError(error: unknown): unknown {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("provider_unavailable");
  }
  if (!(error instanceof APIError)) {
    return error;
  }

  const metadata = OpenAIErrorMetadataSchema.safeParse(error);
  return metadata.success
    ? mapStatusError(metadata.data.status, metadata.data.headers)
    : new ProviderError("provider_unknown");
}
