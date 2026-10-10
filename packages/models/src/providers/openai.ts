// SPDX-License-Identifier: Apache-2.0
import { lookupCapabilities, type Capabilities, type ModelRequest } from "@harness/schemas";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import { ProviderError } from "../errors.js";
import { fromChatResponse, toChatRequest } from "./chat-completions-mapper.js";

/** Secret-value interface accepted at the API-key integration boundary. */
export interface OpenAISecret {
  /** Reveals the API key for the authenticated provider request. */
  reveal(): string;
}

/** OpenAI adapter construction options. */
export interface OpenAIAdapterOptions {
  readonly apiKey: OpenAISecret;
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly capabilities?: Partial<Capabilities>;
}

/** OpenAI Chat Completions provider adapter. */
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai";
  private readonly client: OpenAI;
  private readonly capabilities: Partial<Capabilities>;

  /**
   * Creates an OpenAI adapter with SDK retries disabled.
   *
   * @param options - Secret API key, optional injected fetch, base URL, and capability overrides.
   */
  constructor(options: OpenAIAdapterOptions) {
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
    const capabilities = lookupCapabilities(request.model, this.capabilities).capabilities;
    try {
      const response = await this.client.chat.completions.create(
        toChatRequest(request, {
          structuredOutput: capabilities.structuredOutput,
          parallelToolCalls: capabilities.parallelToolCalls,
        }),
        { signal: context.signal },
      );
      const mapped = fromChatResponse(response, context.ids);
      return {
        ...mapped,
        latencyMs: Math.max(0, context.clock.now() - startedAt),
      };
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

function mapOpenAIError(error: unknown): ProviderError | unknown {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("provider_unavailable");
  }
  if (!(error instanceof APIError)) {
    return error;
  }

  const status = error.status;
  if (status === 429) {
    const retryAfter = error.headers?.get("retry-after");
    const seconds = retryAfter === null || retryAfter === undefined ? Number.NaN : Number(retryAfter);
    return new ProviderError("provider_rate_limited", {
      status,
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1_000 } : {}),
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError("provider_timeout", { status });
  }
  if (status === 401 || status === 403) {
    return new ProviderError("provider_auth", { status });
  }
  if (status === 400) {
    return new ProviderError("provider_bad_request", { status });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("provider_unavailable", { status });
  }
  return new ProviderError("provider_unknown", {
    ...(status === undefined ? {} : { status }),
  });
}
