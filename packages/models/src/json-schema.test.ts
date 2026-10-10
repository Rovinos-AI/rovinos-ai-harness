// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compileJsonSchema, Id } from "@harness/schemas";
import { z } from "zod";
import {
  JsonSchemaError,
  PROVIDER_SCHEMA_RULES,
  lowerForProvider,
  providerSchemaRules,
  schemaHash,
  toJsonSchema,
  type ProviderId,
  type JsonSchema,
} from "./index.js";

const providerRulesFixture = {
  anthropic: {
    allowedKeywords: [
      "additionalProperties",
      "anyOf",
      "description",
      "enum",
      "items",
      "maxItems",
      "minItems",
      "properties",
      "required",
      "title",
      "type",
    ],
    requireAdditionalPropertiesFalse: false,
    requireAllProperties: false,
    unsupportedKeywords: [
      "default",
      "format",
      "maximum",
      "maxLength",
      "minimum",
      "minLength",
      "oneOf",
      "pattern",
    ],
  },
  azure_openai: {
    allowedKeywords: [
      "additionalProperties",
      "anyOf",
      "description",
      "enum",
      "items",
      "maxItems",
      "minItems",
      "properties",
      "required",
      "title",
      "type",
      "maximum",
      "maxLength",
      "minimum",
      "minLength",
      "pattern",
    ],
    requireAdditionalPropertiesFalse: true,
    requireAllProperties: true,
    unsupportedKeywords: ["default", "format", "oneOf"],
  },
  bedrock: {
    allowedKeywords: [
      "additionalProperties",
      "anyOf",
      "description",
      "enum",
      "items",
      "maxItems",
      "minItems",
      "properties",
      "required",
      "title",
      "type",
    ],
    requireAdditionalPropertiesFalse: false,
    requireAllProperties: false,
    unsupportedKeywords: [
      "default",
      "format",
      "maximum",
      "maxLength",
      "minimum",
      "minLength",
      "oneOf",
      "pattern",
    ],
  },
  openai: {
    allowedKeywords: [
      "additionalProperties",
      "anyOf",
      "description",
      "enum",
      "items",
      "maxItems",
      "minItems",
      "properties",
      "required",
      "title",
      "type",
      "maximum",
      "maxLength",
      "minimum",
      "minLength",
      "pattern",
    ],
    requireAdditionalPropertiesFalse: true,
    requireAllProperties: true,
    unsupportedKeywords: ["default", "format", "oneOf"],
  },
  vertex: {
    allowedKeywords: [
      "additionalProperties",
      "anyOf",
      "description",
      "enum",
      "items",
      "maxItems",
      "minItems",
      "properties",
      "required",
      "title",
      "type",
    ],
    requireAdditionalPropertiesFalse: false,
    requireAllProperties: false,
    unsupportedKeywords: [
      "default",
      "format",
      "maximum",
      "maxLength",
      "minimum",
      "minLength",
      "oneOf",
      "pattern",
    ],
  },
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keywordSet(schema: unknown): Set<string> {
  const keywords = new Set<string>();
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isJsonObject(current)) {
      continue;
    }
    for (const [keyword, value] of Object.entries(current)) {
      keywords.add(keyword);
      if (keyword === "properties" && isJsonObject(value)) {
        pending.push(...Object.values(value));
      } else if (
        (keyword === "anyOf" || keyword === "allOf" || keyword === "oneOf") &&
        Array.isArray(value)
      ) {
        for (const entry of value) {
          pending.push(entry);
        }
      } else if (
        (keyword === "items" || keyword === "additionalProperties") &&
        isJsonObject(value)
      ) {
        pending.push(value);
      }
    }
  }
  return keywords;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("provider schema compatibility rules", () => {
  it("keeps the provider support table aligned with its regression fixture", () => {
    expect(PROVIDER_SCHEMA_RULES).toEqual(providerRulesFixture);
    expect(providerSchemaRules("openai")).toEqual(providerRulesFixture.openai);
    expect(providerSchemaRules("unknown")).toBeUndefined();
  });
});

describe("Zod JSON Schema conversion", () => {
  it("converts representative schema constructs to inline draft 2020-12 JSON Schema", () => {
    const schema = z.object({
      id: z.string().regex(/^[a-z0-9]+$/u),
      kind: z.enum(["one", "two"]),
      labels: z.array(z.string()),
      maybe: z.string().nullable().optional(),
      choice: z.union([z.string(), z.number()]),
      score: z.number().min(0).max(10),
      note: z.string().default("synthetic"),
    });

    const result = toJsonSchema(schema);
    expect(result).not.toHaveProperty("$schema");
    expect(JSON.stringify(result)).not.toContain("$ref");
    expect(result).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[a-z0-9]+$" },
        kind: { type: "string", enum: ["one", "two"] },
        labels: { type: "array", items: { type: "string" } },
        maybe: { type: ["string", "null"] },
        choice: { type: ["string", "number"] },
        score: { type: "number", minimum: 0, maximum: 10 },
        note: { type: "string", default: "synthetic" },
      },
      required: ["id", "kind", "labels", "choice", "score"],
    });
  });

  it("rejects recursive schemas with a stable error code", () => {
    const recursive: z.ZodType = z.object({ next: z.lazy(() => recursive).optional() });

    const error = captureError(() => toJsonSchema(recursive));
    expect(error).toBeInstanceOf(JsonSchemaError);
    expect(error).toMatchObject({ code: "schema_recursive_unsupported" });
  });

  it("uses a stable conversion error for Zod types without a JSON Schema representation", () => {
    const error = captureError(() => toJsonSchema(z.date()));
    expect(error).toBeInstanceOf(JsonSchemaError);
    expect(error).toMatchObject({ code: "schema_conversion_failed" });
  });
});

describe("provider schema lowering", () => {
  it("matches the provider-by-provider golden schemas for optional fields and constraints", () => {
    const schema = z.object({
      code: z
        .string()
        .regex(/^[a-z0-9_.-]{1,64}$/u)
        .optional(),
      score: z.number().min(0),
      state: z.enum(["ready", "stopped"]),
      optional: z.string().optional(),
    });
    const strictGolden: JsonSchema = {
      type: "object",
      properties: {
        code: { type: ["string", "null"], pattern: "^[a-z0-9_.-]{1,64}$" },
        score: { type: "number", minimum: 0 },
        state: { type: "string", enum: ["ready", "stopped"] },
        optional: { type: ["string", "null"] },
      },
      required: ["code", "optional", "score", "state"],
      additionalProperties: false,
    };
    const conservativeGolden: JsonSchema = {
      type: "object",
      properties: {
        code: { type: "string" },
        score: { type: "number" },
        state: { type: "string", enum: ["ready", "stopped"] },
        optional: { type: "string" },
      },
      required: ["score", "state"],
    };
    const goldenByProvider: Record<ProviderId, JsonSchema> = {
      anthropic: conservativeGolden,
      azure_openai: strictGolden,
      bedrock: conservativeGolden,
      openai: strictGolden,
      vertex: conservativeGolden,
    };

    for (const [provider, expected] of Object.entries(goldenByProvider)) {
      expect(lowerForProvider(schema, provider).schema).toEqual(expected);
    }
  });

  it("requires optional OpenAI fields as nullable and forbids additional properties", () => {
    const lowered = lowerForProvider(
      z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
      "openai",
    );

    expect(lowered.schema).toEqual({
      type: "object",
      properties: {
        required: { type: "string" },
        optional: { type: ["string", "null"] },
      },
      required: ["optional", "required"],
      additionalProperties: false,
    });
    expect(lowered.dropped).toEqual([]);
  });

  it("removes provider-unsupported keywords and records each dropped name once", () => {
    const schema = z.object({
      contact: z.email(),
      label: z.string().min(3),
      code: z.string().regex(/^[a-z]+$/u),
      score: z.number().min(1).max(5),
      fallback: z.string().default("synthetic"),
    });
    const openAi = lowerForProvider(schema, "openai");
    const anthropic = lowerForProvider(schema, "anthropic");

    expect(openAi.dropped).toEqual(["default", "format", "pattern"]);
    expect(anthropic.dropped).toEqual([
      "default",
      "format",
      "maximum",
      "min_length",
      "minimum",
      "pattern",
    ]);
    expect(openAi.schema).toMatchObject({
      properties: {
        contact: { type: "string" },
        label: { minLength: 3 },
        code: { type: "string" },
        score: { minimum: 1, maximum: 5 },
      },
    });
  });

  it("passes only Id and Code patterns through providers that support pattern", () => {
    const openAiId = lowerForProvider(Id, "openai");
    const anthropicId = lowerForProvider(Id, "anthropic");
    const arbitraryPattern = lowerForProvider(z.string().regex(/^[a-z]+$/u), "openai");

    expect(openAiId.schema).toMatchObject({ pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" });
    expect(anthropicId.dropped).toEqual(["pattern"]);
    expect(arbitraryPattern.dropped).toEqual(["pattern"]);
  });

  it("lowers already converted schemas and removes oneOf and unknown keywords", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
          customConstraint: true,
        },
      },
    };

    const lowered = lowerForProvider(schema, "vertex");
    expect(lowered.schema).toEqual({
      type: "object",
      properties: { value: {} },
    });
    expect(lowered.dropped).toEqual(["custom_constraint", "one_of"]);
  });

  it("normalizes nullable optional schemas and recursively lowers schema-valued keywords", () => {
    const schema: JsonSchema = {
      type: ["object", "null"],
      properties: {
        allowAny: true,
        allowNone: false,
        alreadyNullable: { type: ["string", "null"] },
        nullableEnum: { enum: [null, "ready"] },
        nullableUnion: { anyOf: [{ type: "null" }, { type: "string" }] },
        noType: { description: "synthetic" },
      },
      additionalProperties: { type: "string", pattern: "^[a-z]+$" },
    };

    const lowered = lowerForProvider(schema, "openai");
    expect(lowered.schema).toEqual({
      type: ["object", "null"],
      properties: {
        allowAny: true,
        allowNone: { anyOf: [false, { type: "null" }] },
        alreadyNullable: { type: ["string", "null"] },
        nullableEnum: { enum: [null, "ready"] },
        nullableUnion: { anyOf: [{ type: "null" }, { type: "string" }] },
        noType: { anyOf: [{ description: "synthetic" }, { type: "null" }] },
      },
      required: [
        "allowAny",
        "allowNone",
        "alreadyNullable",
        "noType",
        "nullableEnum",
        "nullableUnion",
      ],
      additionalProperties: false,
    });
    expect(lowered.dropped).toEqual(["additional_properties", "pattern"]);
  });

  it("rejects providers without registered compatibility rules", () => {
    const error = captureError(() => lowerForProvider(z.string(), "provider_x"));
    expect(error).toBeInstanceOf(JsonSchemaError);
    expect(error).toMatchObject({ code: "schema_provider_unsupported" });
  });

  it("only emits provider-allowed keywords and accepts valid Zod samples after lowering", () => {
    const source = z
      .object({
        id: z.string().regex(/^[a-z0-9]+$/u),
        score: z.number().min(0),
        tags: z.array(z.enum(["a", "b"])),
        optional: z.string().nullable().optional(),
      })
      .strict();
    const samples = [
      { id: "abc123", score: 1, tags: ["a"], optional: null },
      { id: "xyz", score: 4, tags: ["b"], optional: "present" },
    ];
    for (const provider of ["openai", "anthropic", "bedrock", "vertex"]) {
      const lowered = lowerForProvider(source, provider);
      const rules = providerSchemaRules(provider);
      const allowed = new Set(rules?.allowedKeywords ?? []);
      const keywords = keywordSet(lowered.schema);
      expect([...keywords].every((keyword) => allowed.has(keyword))).toBe(true);

      const validate = compileJsonSchema(lowered.schema);
      for (const sample of samples) {
        expect(source.safeParse(sample).success).toBe(true);
        expect(() => {
          validate(sample);
        }).not.toThrow();
      }
    }
  });
});

describe("JSON Schema hashing", () => {
  it("hashes canonical JSON independently of object and required-property order", () => {
    const first: JsonSchema = {
      type: "object",
      properties: {
        alpha: { type: "string" },
        beta: { type: "number" },
      },
      required: ["alpha", "beta"],
    };
    const reordered: JsonSchema = {
      required: ["beta", "alpha"],
      properties: {
        beta: { type: "number" },
        alpha: { type: "string" },
      },
      type: "object",
    };

    expect(schemaHash(first)).toBe(schemaHash(reordered));
    expect(schemaHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(schemaHash({ value: null })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
