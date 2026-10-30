// SPDX-License-Identifier: Apache-2.0
// Models retry configuration is owned by task 14.12.
// Models provider and routing configuration is owned by tasks 14.13 and 14.19.
// OpenAI-compatible provider quirks are owned by task 14.6.
// Models pricing configuration is owned by task 14.14.
import { z } from "zod";
import { CapabilitiesSchema } from "../capabilities.js";
import { ModelRefSchema } from "../messages.js";
import { Code } from "../primitives.js";
import { SecretRefSchema } from "../secret-ref.js";

/** Ordered model references selected by the model gateway. */
export const ModelRoutingConfigSchema = z
  .object({
    default: z.array(ModelRefSchema).default([]),
    roles: z.record(Code, z.array(ModelRefSchema)).default({}),
    fallbackOn: z
      .array(Code)
      .default([
        "provider_rate_limited",
        "provider_timeout",
        "provider_unavailable",
        "model_output_invalid",
      ]),
  })
  .strict()
  .prefault({});

/** Provider adapter configuration owned by the model gateway. */
function validateBedrockProvider(
  provider: {
    readonly apiKey?: string | undefined;
    readonly modelIds?: Readonly<Record<string, unknown>> | undefined;
    readonly region?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (provider.region !== undefined && !/^[a-z]{2}(?:-[a-z]+)+-\d+$/u.test(provider.region)) {
    context.addIssue({
      code: "custom",
      path: ["region"],
      message: "Bedrock region must be a valid AWS region identifier.",
      params: { errorCode: "provider_region_invalid" },
    });
  }
  if (provider.region === undefined) {
    context.addIssue({
      code: "custom",
      path: ["region"],
      message: "Bedrock providers require a region.",
      params: { errorCode: "provider_region_required" },
    });
  }
  if (provider.modelIds === undefined || Object.keys(provider.modelIds).length === 0) {
    context.addIssue({
      code: "custom",
      path: ["modelIds"],
      message: "Bedrock providers require at least one model id.",
      params: { errorCode: "provider_model_ids_required" },
    });
  }
  if (provider.apiKey !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["apiKey"],
      message: "Bedrock credentials use the AWS default provider chain.",
      params: { errorCode: "provider_api_key_unsupported" },
    });
  }
}

/** Provider request-mapping quirks for OpenAI-compatible endpoints. */
export const ModelProviderQuirksSchema = z
  .object({
    useMaxTokens: z.boolean().optional(),
    supportsStrictSchema: z.boolean().optional(),
  })
  .strict();

export const ModelProviderConfigSchema = z
  .object({
    id: Code,
    kind: z.enum(["anthropic", "bedrock", "openai", "openai_compatible"]),
    apiKey: SecretRefSchema.optional(),
    baseUrl: z.url().optional(),
    region: z.string().min(1).optional(),
    modelIds: z.record(Code, z.string().min(1)).optional(),
    maxOutputTokens: z.number().int().positive().default(4_096),
    requestsPerMinute: z.number().int().positive().optional(),
    streaming: z.boolean().default(true),
    capabilities: CapabilitiesSchema.partial().strict().optional(),
    quirks: ModelProviderQuirksSchema.optional(),
    trust: z.enum(["hosted", "local"]).default("hosted"),
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.kind === "bedrock") {
      validateBedrockProvider(provider, context);
    }
    if (provider.kind === "openai_compatible" && provider.baseUrl === undefined) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "OpenAI-compatible providers require baseUrl.",
        params: { errorCode: "provider_base_url_required" },
      });
    }
    if (provider.baseUrl !== undefined) {
      const host = new URL(provider.baseUrl).hostname;
      const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      const isHttps = new URL(provider.baseUrl).protocol === "https:";
      if (!isHttps && !isLoopback && provider.trust !== "local") {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "Remote provider URLs must use HTTPS unless trust is local.",
          params: { errorCode: "provider_base_url_untrusted" },
        });
      }
    }
  });

/** Gateway retry and per-attempt timeout policy, owned by model task 14.12. */
export const ModelRetryConfigSchema = z
  .object({
    maxAttempts: z.coerce.number().int().positive().default(3),
    baseDelayMs: z.coerce.number().int().nonnegative().default(500),
    maxDelayMs: z.coerce.number().int().nonnegative().default(20_000),
    timeoutMs: z.coerce.number().int().positive().default(120_000),
    streamTimeoutMs: z.coerce.number().int().positive().default(600_000),
    idleTimeoutMs: z.coerce.number().int().positive().default(60_000),
  })
  .strict()
  .superRefine((retry, context) => {
    if (retry.streamTimeoutMs < retry.timeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["streamTimeoutMs"],
        message: "Streaming timeout must be at least the request timeout.",
        params: { errorCode: "stream_timeout_before_request_timeout" },
      });
    }
  })
  .prefault({});

/** Configured input, output, and optional cached-token prices in integer micros per million tokens. */
export const ModelPricingRateSchema = z
  .object({
    inputMicrosPerMTok: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputMicrosPerMTok: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheReadMicrosPerMTok: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    cacheWriteMicrosPerMTok: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

const modelPricingKey = z.string().regex(/^[a-z0-9_.-]{1,64}\/[a-z0-9_.-]{1,64}$/u);

/** Structured-output repair policy, owned by model task 14.10. */
export const ModelEnforcementConfigSchema = z
  .object({
    maxRepairs: z.coerce.number().int().nonnegative().default(2),
  })
  .strict()
  .prefault({});

/** Models configuration fields consumed by the model gateway. */
export const ModelsConfigSchema = z
  .object({
    retry: ModelRetryConfigSchema,
    enforcement: ModelEnforcementConfigSchema,
    maxConcurrent: z.coerce.number().int().positive().default(4),
    pricing: z.record(modelPricingKey, ModelPricingRateSchema).default({}),
    providers: z
      .array(ModelProviderConfigSchema)
      .default([])
      .superRefine((providers, context) => {
        const ids = new Set<string>();
        for (const [index, provider] of providers.entries()) {
          if (ids.has(provider.id)) {
            context.addIssue({
              code: "custom",
              path: [index, "id"],
              message: "Provider ids must be unique.",
              params: { errorCode: "provider_id_duplicate" },
            });
          }
          ids.add(provider.id);
        }
      }),
    routing: ModelRoutingConfigSchema,
  })
  .strict()
  .prefault({});

/** Inferred retry policy after applying defaults. */
export type ModelRetryConfig = z.infer<typeof ModelRetryConfigSchema>;
/** Inferred configured model prices. */
export type ModelPricingRate = z.infer<typeof ModelPricingRateSchema>;
/** Inferred structured-output enforcement policy after applying defaults. */
export type ModelEnforcementConfig = z.infer<typeof ModelEnforcementConfigSchema>;
/** Inferred model gateway configuration after applying defaults. */
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
/** Inferred ordered routing configuration after applying defaults. */
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;
/** Inferred provider adapter configuration. */
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;
/** Inferred request-mapping quirks for an OpenAI-compatible provider. */
export type ModelProviderQuirks = z.infer<typeof ModelProviderQuirksSchema>;
