// SPDX-License-Identifier: Apache-2.0
import { ModelProviderConfigSchema, type ModelProviderQuirks } from "@rovinos/schemas";
import { OpenAIAdapter, type OpenAIAdapterOptions, type OpenAISecret } from "./openai.js";

/** Construction options for an OpenAI-compatible endpoint. */
export interface OpenAICompatibleAdapterOptions extends Omit<
  OpenAIAdapterOptions,
  "apiKey" | "kind" | "trust"
> {
  /** Optional API key for endpoints that require authentication. */
  readonly apiKey?: OpenAISecret;
  /** Configured provider trust level. */
  readonly trust?: "hosted" | "local";
  /** Required base URL for the compatible Chat Completions endpoint. */
  readonly baseURL: string;
  /** Request-shape differences supported by the endpoint. */
  readonly quirks?: ModelProviderQuirks;
}

/** OpenAI Chat Completions adapter for compatible local or hosted endpoints. */
export class OpenAICompatibleAdapter extends OpenAIAdapter {
  override readonly kind = "openai_compatible" as const;

  /** @param options - Endpoint URL, optional secret, capabilities, trust, and request quirks. */
  constructor(options: OpenAICompatibleAdapterOptions) {
    const config = ModelProviderConfigSchema.parse({
      id: options.provider ?? "openai_compatible",
      kind: "openai_compatible",
      baseUrl: options.baseURL,
      trust: options.trust ?? "hosted",
    });
    const apiKey: OpenAISecret = options.apiKey ?? { reveal: () => "not-needed" };
    super({
      ...options,
      apiKey,
      provider: config.id,
      kind: "openai_compatible",
      baseURL: options.baseURL,
      trust: config.trust,
    });
  }
}
