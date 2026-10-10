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

function normalizeUndefined(value: unknown, nullable: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUndefined(entry, nullable));
  }
  if (isJsonObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        if (nullable) {
          normalized[key] = null;
        }
      } else {
        normalized[key] = normalizeUndefined(entry, nullable);
      }
    }
    return normalized;
  }
  return value;
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

  it("does not treat a property named $ref as a schema reference", () => {
    const converted = toJsonSchema(z.object({ $ref: z.string() }));

    expect(converted).toMatchObject({
      properties: { $ref: { type: "string" } },
    });
    expect(lowerForProvider(z.object({ $ref: z.string() }), "openai").schema).toMatchObject({
      properties: { $ref: { type: "string" } },
    });
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
      const sample = {
        score: 0,
        state: "ready",
        code: undefined,
        optional: undefined,
      };
      expect(schema.safeParse(sample).success).toBe(true);
      const providerSample = normalizeUndefined(
        sample,
        providerSchemaRules(provider)?.requireAllProperties === true,
      );
      expect(() => {
        compileJsonSchema(expected)(providerSample);
      }).not.toThrow();
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

  it("rewrites oneOf branches and drops unsupported constraints", () => {
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
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect(lowered.dropped).toEqual(["custom_constraint"]);
  });

  it("normalizes nullable optional schemas and recursively lowers schema-valued keywords", () => {
    const schema: JsonSchema = {
      type: ["object", "null"],
      properties: {
        allowAny: true,
        allowNone: false,
        alreadyNullable: { type: ["string", "null"] },
        nullableEnum: { type: "string", enum: [null, "ready"] },
        optionalEnum: { type: "string", enum: ["ready", "stopped"] },
        nullableUnion: { anyOf: [{ type: "null" }, { type: "string" }] },
        noType: { description: "synthetic" },
      },
      additionalProperties: false,
    };

    const lowered = lowerForProvider(schema, "openai");
    expect(lowered.schema).toEqual({
      type: ["object", "null"],
      properties: {
        allowAny: true,
        allowNone: { anyOf: [false, { type: "null" }] },
        alreadyNullable: { type: ["string", "null"] },
        nullableEnum: {
          anyOf: [{ type: "string", enum: [null, "ready"] }, { type: "null" }],
        },
        optionalEnum: {
          anyOf: [{ type: "string", enum: ["ready", "stopped"] }, { type: "null" }],
        },
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
        "optionalEnum",
      ],
      additionalProperties: false,
    });
    expect(lowered.dropped).toEqual([]);
  });

  it("rejects provider-incompatible schema-bearing keywords, tuples, and strict records", () => {
    const unsupportedSchemas: JsonSchema[] = [
      { allOf: [{ type: "string" }] },
      { prefixItems: [{ type: "string" }], minItems: 1 },
      { not: { type: "null" } },
      { if: { type: "string" }, then: { minLength: 1 } },
      { patternProperties: { "^x": { type: "string" } } },
      { propertyNames: { type: "string", minLength: 1 } },
      { dependentSchemas: { trigger: { required: ["value"] } } },
    ];
    for (const schema of unsupportedSchemas) {
      const error = captureError(() => lowerForProvider(schema, "openai"));
      expect(error).toBeInstanceOf(JsonSchemaError);
      expect(error).toMatchObject({ code: "schema_provider_unsupported" });
    }

    const tuple = z.tuple([z.string(), z.number()]);
    expect(tuple.safeParse(["pair", 1]).success).toBe(true);
    for (const provider of ["openai", "anthropic"]) {
      expect(captureError(() => lowerForProvider(tuple, provider))).toMatchObject({
        code: "schema_provider_unsupported",
      });
    }

    const record = z.record(z.string(), z.string());
    expect(record.safeParse({ tag: "synthetic" }).success).toBe(true);
    expect(captureError(() => lowerForProvider(record, "openai"))).toMatchObject({
      code: "schema_provider_unsupported",
    });

    const catchall = z.object({ tag: z.string() }).catchall(z.string());
    expect(catchall.safeParse({ tag: "synthetic", extra: "value" }).success).toBe(true);
    expect(captureError(() => lowerForProvider(catchall, "openai"))).toMatchObject({
      code: "schema_provider_unsupported",
    });
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

  it("preserves accepted samples across supported schemas and providers with Ajv 2020", () => {
    const preservationCases = [
      {
        schema: z.discriminatedUnion("action", [
          z.object({ action: z.literal("start"), id: z.string() }),
          z.object({ action: z.literal("stop"), force: z.boolean() }),
        ]),
        samples: [
          { action: "start", id: "synthetic" },
          { action: "stop", force: true },
        ],
        providers: ["openai", "anthropic"] as const,
      },
      {
        schema: z.object({
          state: z.enum(["ready", "stopped"]).optional(),
        }),
        samples: [{ state: "ready" }, { state: undefined }],
        providers: ["openai", "anthropic"] as const,
      },
      {
        schema: z.object({ state: z.literal("active").optional() }),
        samples: [{ state: "active" }, { state: undefined }],
        providers: ["openai", "anthropic"] as const,
      },
      {
        schema: z.record(z.string(), z.string()),
        samples: [{ tag: "synthetic" }, {}],
        providers: ["anthropic", "vertex"] as const,
      },
      {
        schema: z.intersection(z.object({ id: z.string() }), z.object({ score: z.number() })),
        samples: [{ id: "synthetic", score: 1 }],
        providers: ["openai", "anthropic"] as const,
      },
      {
        schema: z.literal("active"),
        samples: ["active"],
        providers: ["openai", "anthropic"] as const,
      },
    ];

    for (const { schema, samples, providers } of preservationCases) {
      for (const provider of providers) {
        const lowered = lowerForProvider(schema, provider).schema;
        const validate = compileJsonSchema(lowered);
        for (const sample of samples) {
          expect(schema.safeParse(sample).success).toBe(true);
          const providerSample = normalizeUndefined(
            sample,
            providerSchemaRules(provider)?.requireAllProperties === true,
          );
          expect(() => {
            validate(providerSample);
          }).not.toThrow();
        }
      }
    }
  });

  it("preserves union discriminators and literals in provider schemas", () => {
    const schema = z.object({
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), x: z.number() }),
        z.object({ kind: z.literal("b"), y: z.string() }),
      ]),
    });
    const openUnion: JsonSchema = {
      type: "object",
      properties: {
        action: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["a"] },
                x: { type: "number" },
              },
              required: ["kind", "x"],
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["b"] },
                y: { type: "string" },
              },
              required: ["kind", "y"],
            },
          ],
        },
      },
      required: ["action"],
    };
    const strictUnion: JsonSchema = {
      type: "object",
      properties: {
        action: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["a"] },
                x: { type: "number" },
              },
              required: ["kind", "x"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["b"] },
                y: { type: "string" },
              },
              required: ["kind", "y"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["action"],
      additionalProperties: false,
    };
    const goldenByProvider: Record<ProviderId, JsonSchema> = {
      anthropic: openUnion,
      azure_openai: strictUnion,
      bedrock: openUnion,
      openai: strictUnion,
      vertex: openUnion,
    };

    for (const [provider, expected] of Object.entries(goldenByProvider)) {
      const lowered = lowerForProvider(schema, provider);
      expect(lowered.schema).toEqual(expected);
      expect(lowered.dropped).toEqual([]);
      const validate = compileJsonSchema(lowered.schema);
      expect(() => {
        validate({ action: { kind: "a", x: 1 } });
      }).not.toThrow();
      expect(() => {
        validate({ action: { kind: "c", x: 1 } });
      }).toThrow();
    }

    for (const provider of Object.keys(goldenByProvider)) {
      const literal = lowerForProvider(z.literal("active"), provider);
      expect(literal.schema).toEqual({
        type: "string",
        enum: ["active"],
      });
      expect(literal.dropped).toEqual([]);
      const literalArray = lowerForProvider(z.array(z.literal("active")), provider);
      expect(literalArray.schema).toEqual({
        type: "array",
        items: { type: "string", enum: ["active"] },
      });
      expect(literalArray.dropped).toEqual([]);
    }
  });
});

describe("JSON Schema hashing", () => {
  it("hashes canonical JSON independently of object, required, and type array order", () => {
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
    expect(schemaHash({ type: ["string", "null"] })).toBe(schemaHash({ type: ["null", "string"] }));
    expect(schemaHash({ required: ["éclair", "zebra"] })).toBe(
      schemaHash({ required: ["zebra", "éclair"] }),
    );
    expect(schemaHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(schemaHash({ value: null })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
