// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ModelEnforcementConfigSchema,
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
        retry: { maxAttempts: "5", timeoutMs: "2000" },
        enforcement: { maxRepairs: "1" },
        maxConcurrent: "2",
      }),
    ).toEqual({
      retry: {
        maxAttempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 20_000,
        timeoutMs: 2_000,
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

  it("validates per-model input and output prices", () => {
    expect(
      ModelsConfigSchema.parse({
        pricing: {
          "sample/model-a": { inputMicrosPerMTok: 125, outputMicrosPerMTok: 375 },
        },
      }).pricing,
    ).toEqual({
      "sample/model-a": { inputMicrosPerMTok: 125, outputMicrosPerMTok: 375 },
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
      }).providers[0]?.maxOutputTokens,
    ).toBe(4_096);
    expect(
      ModelsConfigSchema.parse({
        providers: [{ id: "anthropic", kind: "anthropic", maxOutputTokens: 512 }],
      }).providers[0]?.maxOutputTokens,
    ).toBe(512);
    for (const maxOutputTokens of [0, -1, 1.5]) {
      expect(() =>
        ModelsConfigSchema.parse({
          providers: [{ id: "anthropic", kind: "anthropic", maxOutputTokens }],
        }),
      ).toThrow();
    }
  });
});
