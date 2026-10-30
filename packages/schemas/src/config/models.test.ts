// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ModelEnforcementConfigSchema,
  ModelProviderConfigSchema,
  ModelRetryConfigSchema,
  ModelsConfigSchema,
} from "./models.js";

describe("ModelsConfigSchema", () => {
  it("defaults retry and concurrency policies", () => {
    expect(ModelsConfigSchema.parse({})).toEqual({
      retry: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        timeoutMs: 120_000,
        streamTimeoutMs: 600_000,
        idleTimeoutMs: 60_000,
      },
      enforcement: { maxRepairs: 2 },
      maxConcurrent: 4,
      pricing: {},
      providers: [],
      routing: {
        default: [],
        roles: {},
        fallbackOn: [
          "provider_rate_limited",
          "provider_timeout",
          "provider_unavailable",
          "model_output_invalid",
        ],
      },
    });
  });

  it("accepts configured retry overrides", () => {
    expect(
      ModelsConfigSchema.parse({
        retry: { maxAttempts: "5", timeoutMs: "2000", streamTimeoutMs: "300000" },
        enforcement: { maxRepairs: "1" },
        maxConcurrent: "2",
      }),
    ).toEqual({
      retry: {
        maxAttempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        timeoutMs: 2_000,
        streamTimeoutMs: 300_000,
        idleTimeoutMs: 60_000,
      },
      enforcement: { maxRepairs: 1 },
      maxConcurrent: 2,
      pricing: {},
      providers: [],
      routing: {
        default: [],
        roles: {},
        fallbackOn: [
          "provider_rate_limited",
          "provider_timeout",
          "provider_unavailable",
          "model_output_invalid",
        ],
      },
    });
  });

  it("rejects invalid retry values and unknown settings", () => {
    expect(() => ModelRetryConfigSchema.parse({ maxAttempts: 0 })).toThrow();
    expect(() => ModelEnforcementConfigSchema.parse({ maxRepairs: -1 })).toThrow();
    expect(() => ModelsConfigSchema.parse({ retry: { unrecognized: true } })).toThrow();
  });

  it("requires the streaming timeout to cover the request timeout", () => {
    expect(() =>
      ModelRetryConfigSchema.parse({ timeoutMs: 120_001, streamTimeoutMs: 120_000 }),
    ).toThrow();
    expect(
      ModelRetryConfigSchema.parse({ timeoutMs: 120_000, streamTimeoutMs: 120_000 }),
    ).toMatchObject({ timeoutMs: 120_000, streamTimeoutMs: 120_000 });
  });

  it("validates per-model input and output prices", () => {
    expect(
      ModelsConfigSchema.parse({
        pricing: {
          "sample/model-a": {
            inputMicrosPerMTok: 125,
            outputMicrosPerMTok: 375,
            cacheReadMicrosPerMTok: 25,
            cacheWriteMicrosPerMTok: 200,
          },
        },
      }).pricing,
    ).toEqual({
      "sample/model-a": {
        inputMicrosPerMTok: 125,
        outputMicrosPerMTok: 375,
        cacheReadMicrosPerMTok: 25,
        cacheWriteMicrosPerMTok: 200,
      },
    });
    expect(() =>
      ModelsConfigSchema.parse({
        pricing: { "invalid/key/name": { inputMicrosPerMTok: 1, outputMicrosPerMTok: 2 } },
      }),
    ).toThrow();
    expect(() =>
      ModelsConfigSchema.parse({
        pricing: { "sample/model-a": { inputMicrosPerMTok: -1, outputMicrosPerMTok: 2 } },
      }),
    ).toThrow();
  });

  it("validates ordered routing references and provider configuration", () => {
    expect(
      ModelsConfigSchema.parse({
        providers: [{ id: "openai", kind: "openai", apiKey: "env:OPENAI_API_KEY" }],
        routing: {
          default: [
            { provider: "openai", model: "gpt-4o-mini" },
            { provider: "anthropic", model: "claude-sonnet" },
          ],
          roles: { planner: [{ provider: "anthropic", model: "claude-sonnet" }] },
        },
      }).routing,
    ).toMatchObject({
      default: [
        { provider: "openai", model: "gpt-4o-mini" },
        { provider: "anthropic", model: "claude-sonnet" },
      ],
      roles: { planner: [{ provider: "anthropic", model: "claude-sonnet" }] },
    });

    expect(() =>
      ModelsConfigSchema.parse({
        routing: { default: [{ provider: "openai", model: "gpt-4o-mini" }], roles: {} },
      }),
    ).not.toThrow();
    expect(() =>
      ModelsConfigSchema.parse({ providers: [{ id: "invalid", kind: "other" }] }),
    ).toThrow();
    expect(() =>
      ModelsConfigSchema.parse({ providers: [{ id: "local", kind: "openai_compatible" }] }),
    ).toThrow();
    expect(() =>
      ModelsConfigSchema.parse({
        providers: [
          {
            id: "bedrock",
            kind: "bedrock",
            region: "us-east-1",
            modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
          },
        ],
      }),
    ).not.toThrow();
    for (const provider of [
      {
        id: "bedrock",
        kind: "bedrock",
        modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
      },
      {
        id: "bedrock",
        kind: "bedrock",
        region: "us-east-1",
      },
      {
        id: "bedrock",
        kind: "bedrock",
        region: "us-east-1",
        modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
        accessKeyId: "synthetic",
        secretAccessKey: "synthetic",
      },
      {
        id: "bedrock",
        kind: "bedrock",
        region: "us-east-1",
        modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
        apiKey: "env:AWS_ACCESS_KEY_ID",
      },
    ]) {
      expect(() => ModelsConfigSchema.parse({ providers: [provider] })).toThrow();
    }
    expect(() =>
      ModelsConfigSchema.parse({
        providers: [{ id: "remote", kind: "openai_compatible", baseUrl: "http://model.example" }],
      }),
    ).toThrow();
    expect(() =>
      ModelsConfigSchema.parse({
        providers: [{ id: "remote", kind: "openai_compatible", baseUrl: "HTTPS://model.example" }],
      }),
    ).not.toThrow();
    expect(() =>
      ModelsConfigSchema.parse({
        providers: [
          {
            id: "local",
            kind: "openai_compatible",
            baseUrl: "http://model.example",
            trust: "local",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      ModelsConfigSchema.parse({
        providers: [
          { id: "openai", kind: "openai", apiKey: "env:ONE" },
          { id: "openai", kind: "openai", apiKey: "env:TWO" },
        ],
      }),
    ).toThrow();
  });

  it("defaults provider output limits and requires positive integer overrides", () => {
    expect(
      ModelsConfigSchema.parse({
        providers: [{ id: "anthropic", kind: "anthropic" }],
      }).providers[0],
    ).toMatchObject({ maxOutputTokens: 4_096, streaming: true });
    expect(
      ModelsConfigSchema.parse({
        providers: [{ id: "anthropic", kind: "anthropic", maxOutputTokens: 512, streaming: false }],
      }).providers[0],
    ).toMatchObject({ maxOutputTokens: 512, streaming: false });
    for (const maxOutputTokens of [0, -1, 1.5]) {
      expect(() =>
        ModelsConfigSchema.parse({
          providers: [{ id: "anthropic", kind: "anthropic", maxOutputTokens }],
        }),
      ).toThrow();
    }
  });

  it("parses Bedrock provider configuration and rejects malformed AWS regions", () => {
    expect(
      ModelProviderConfigSchema.parse({
        id: "bedrock",
        kind: "bedrock",
        region: "us-east-1",
        modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
      }),
    ).toMatchObject({ kind: "bedrock", region: "us-east-1" });
    expect(() =>
      ModelProviderConfigSchema.parse({
        id: "bedrock",
        kind: "bedrock",
        region: "us-east-1.evil.com",
        modelIds: { "nova-pro": "amazon.nova-pro-v1:0" },
      }),
    ).toThrow();
  });

  it("applies the HTTP trust rule to OpenAI-compatible provider URL combinations", () => {
    const cases: readonly {
      readonly baseUrl: string;
      readonly trust?: "local";
      readonly accepted: boolean;
    }[] = [
      { baseUrl: "http://localhost:11434", accepted: true },
      { baseUrl: "http://127.0.0.1:11434", accepted: true },
      { baseUrl: "http://[::1]:11434", accepted: true },
      { baseUrl: "https://model.example.test/v1", accepted: true },
      { baseUrl: "http://model.example.test/v1", accepted: false },
      { baseUrl: "http://192.0.2.10:11434", accepted: false },
      { baseUrl: "http://model.example.test/v1", trust: "local", accepted: true },
    ];

    for (const { baseUrl, trust, accepted } of cases) {
      const result = ModelProviderConfigSchema.safeParse({
        id: "local-model",
        kind: "openai_compatible",
        baseUrl,
        ...(trust === undefined ? {} : { trust }),
      });
      expect(result.success, `${baseUrl} with trust ${trust ?? "default"}`).toBe(accepted);
    }
  });

  it("validates and defaults compatible-endpoint request quirks", () => {
    expect(
      ModelProviderConfigSchema.parse({
        id: "local-model",
        kind: "openai_compatible",
        baseUrl: "http://localhost:11434",
        quirks: {},
      }).quirks,
    ).toEqual({});
    expect(
      ModelProviderConfigSchema.parse({
        id: "local-model",
        kind: "openai_compatible",
        baseUrl: "http://localhost:11434",
        quirks: { useMaxTokens: true, supportsStrictSchema: false },
      }).quirks,
    ).toEqual({ useMaxTokens: true, supportsStrictSchema: false });
    expect(() =>
      ModelProviderConfigSchema.parse({
        id: "local-model",
        kind: "openai_compatible",
        baseUrl: "http://localhost:11434",
        quirks: { unknown: true },
      }),
    ).toThrow();
  });
});
