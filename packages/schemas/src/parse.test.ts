// SPDX-License-Identifier: Apache-2.0
import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ContractError, parseJson, parseYaml, safeParseJson } from "./parse.js";
import { compileJsonSchema } from "./json-schema.js";

const valueSchema = z
  .object({
    name: z.string(),
    count: z.number(),
  })
  .strict();

it("parses JSON and YAML into the inferred schema type", () => {
  const json = parseJson(valueSchema, '{"name":"sample","count":3}');
  const yaml = parseYaml(valueSchema, "name: sample\ncount: 3\n");

  expect(json).toEqual({ name: "sample", count: 3 });
  expect(yaml).toEqual(json);
  expectTypeOf(json).toEqualTypeOf<{ name: string; count: number }>();
});

it("returns a value-free error for invalid JSON and YAML", () => {
  const jsonError = safeParseJson(valueSchema, '{"name":"private-value"');
  expect(jsonError.success).toBe(false);
  if (!jsonError.success) {
    expect(jsonError.error).toBeInstanceOf(ContractError);
    expect(jsonError.error.code).toBe("contract_invalid");
    expect(jsonError.error.issues).toEqual([{ path: [], code: "invalid_json" }]);
    expect(jsonError.error.message).not.toContain("private-value");
  }

  let yamlError: unknown;
  try {
    parseYaml(valueSchema, "name: private-value\ncount: [");
  } catch (error) {
    yamlError = error;
  }
  expect(yamlError).toBeInstanceOf(ContractError);
  if (yamlError instanceof ContractError) {
    expect(yamlError.message).not.toContain("private-value");
    expect(JSON.stringify(yamlError.issues)).not.toContain("private-value");
  }
});

it("enforces UTF-8 byte limits before parsing JSON and YAML", () => {
  for (const parse of [
    () => parseJson(valueSchema, '{"name":"é","count":1}', { maxBytes: 1 }),
    () => parseYaml(valueSchema, "name: é\ncount: 1\n", { maxBytes: 1 }),
  ]) {
    expect(parse).toThrowError(
      expect.objectContaining({
        code: "contract_invalid",
        issues: [{ path: [], code: "size_limit_exceeded" }],
      }),
    );
  }
});

it("does not expose submitted values in Zod validation issues", () => {
  let error: unknown;
  try {
    parseJson(valueSchema, '{"name":"private-value","count":"hidden"}');
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(ContractError);
  if (error instanceof ContractError) {
    expect(error.issues).toEqual([{ path: ["count"], code: "invalid_type" }]);
    expect(error.message).not.toContain("private-value");
    expect(JSON.stringify(error.issues)).not.toContain("hidden");
  }
});

it("compiles a draft 2020-12 schema and validates format and prefixItems", () => {
  const validate = compileJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      contact: { type: "string", format: "email" },
      values: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
        items: false,
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ["contact", "values"],
    unevaluatedProperties: false,
  });

  expect(() => validate({ contact: "person@example.test", values: ["text", 2] })).not.toThrow();
  expect(() => validate({ contact: "not-an-email", values: ["text", 2] })).toThrow(ContractError);
});

it("bounds local reference depth and rejects remote references", () => {
  const chain = {
    $defs: {
      first: { $ref: "#/$defs/second" },
      second: { type: "string" },
    },
    properties: { value: { $ref: "#/$defs/first" } },
  };

  expect(() => compileJsonSchema(chain, { maxRefDepth: 1 })).toThrow(ContractError);
  expect(() =>
    compileJsonSchema({ $ref: "https://schemas.invalid/external.json" }),
  ).toThrow(ContractError);
});

it("bounds the external schema size and keeps compile errors value-free", () => {
  expect(() => compileJsonSchema({ title: "private-schema" }, { maxBytes: 1 })).toThrow(
    ContractError,
  );

  let error: unknown;
  try {
    compileJsonSchema({ $ref: "https://schemas.invalid/private-schema" });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ContractError);
  if (error instanceof ContractError) {
    expect(error.message).not.toContain("private-schema");
    expect(JSON.stringify(error.issues)).not.toContain("private-schema");
  }
});
