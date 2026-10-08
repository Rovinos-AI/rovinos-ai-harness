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

function assertContractError(error: unknown): ContractError {
  expect(error).toBeInstanceOf(ContractError);
  if (!(error instanceof ContractError)) {
    throw new TypeError("Expected a contract error.");
  }
  return error;
}

function captureContractError(action: () => unknown): ContractError {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  return assertContractError(error);
}

it("parses JSON and YAML into the inferred schema type", () => {
  const json = parseJson(valueSchema, '{"name":"sample","count":3}');
  const yaml = parseYaml(valueSchema, "name: sample\ncount: 3\n");

  expect(json).toEqual({ name: "sample", count: 3 });
  expect(yaml).toEqual(json);
  expectTypeOf(json).toEqualTypeOf<{ name: string; count: number }>();
});

it("returns a value-free error for invalid JSON and YAML", () => {
  const result = safeParseJson(valueSchema, '{"name":"private-value"');
  expect(result.success).toBe(false);
  const jsonError = assertContractError(result.success ? undefined : result.error);
  expect(jsonError.code).toBe("contract_invalid");
  expect(jsonError.issues).toEqual([{ path: [], code: "invalid_json" }]);
  expect(jsonError.message).not.toContain("private-value");
  expect(safeParseJson(valueSchema, '{"name":"sample","count":3}').success).toBe(true);

  const yamlError = captureContractError(() =>
    parseYaml(valueSchema, "name: private-value\ncount: ["),
  );
  expect(yamlError.message).not.toContain("private-value");
  expect(JSON.stringify(yamlError.issues)).not.toContain("private-value");
});

it("enforces UTF-8 byte limits before parsing JSON and YAML", () => {
  for (const parse of [
    () => parseJson(valueSchema, "{ invalid", { maxBytes: 1 }),
    () => parseYaml(valueSchema, "name: é\ncount: 1\n", { maxBytes: 1 }),
  ]) {
    const error = captureContractError(parse);
    expect(error.issues).toEqual([{ path: [], code: "size_limit_exceeded" }]);
  }
});

it("does not expose submitted values in Zod validation issues", () => {
  const error = captureContractError(() =>
    parseJson(valueSchema, '{"name":"private-value","count":"hidden"}'),
  );
  expect(error.issues).toEqual([{ path: ["count"], code: "invalid_type" }]);
  expect(error.message).not.toContain("private-value");
  expect(JSON.stringify(error.issues)).not.toContain("hidden");
});

it("sanitizes errors thrown by Zod transformations", () => {
  const throwingSchema = z.string().transform(() => {
    throw new Error("private-value");
  });
  const error = captureContractError(() => parseJson(throwingSchema, '"private-value"'));

  expect(error.issues).toEqual([{ path: [], code: "validation_failed" }]);
  expect(error.message).not.toContain("private-value");
  expect(JSON.stringify(error.issues)).not.toContain("private-value");
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

  expect(() => {
    validate({ contact: "person@example.test", values: ["text", 2] });
  }).not.toThrow();
  expect(() => {
    validate({ contact: "not-an-email", values: ["text", 2] });
  }).toThrow(ContractError);
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
  expect(() => {
    compileJsonSchema({ $ref: "https://schemas.invalid/external.json" });
  }).toThrow(ContractError);
});

it("supports recursive schemas and leaves example data outside reference checks", () => {
  const validateRecursive = compileJsonSchema(
    {
      $defs: {
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/node",
    },
    { maxRefDepth: 1 },
  );
  const validateExample = compileJsonSchema({
    type: "object",
    properties: { example: { const: { $ref: "https://example.invalid/not-a-reference" } } },
  });

  expect(() => {
    validateRecursive({ next: { next: {} } });
  }).not.toThrow();
  expect(() => {
    validateExample({ example: { $ref: "https://example.invalid/not-a-reference" } });
  }).not.toThrow();
});

it("resolves local anchors and validates boolean JSON Schemas", () => {
  const validateAnchor = compileJsonSchema({
    type: "object",
    $defs: { name: { $anchor: "name", type: "string" } },
    properties: { name: { $ref: "#name" } },
  });
  const validateTrue = compileJsonSchema(true);
  const validateFalse = compileJsonSchema(false);

  expect(() => {
    validateAnchor({ name: "sample" });
    validateTrue({ any: "value" });
  }).not.toThrow();
  expect(
    captureContractError(() => {
      validateFalse("value");
    }).issues,
  ).toEqual([{ path: [], code: "json_schema_false schema" }]);
});

it("resolves references through tuple arrays and reports numeric error paths", () => {
  const validateReference = compileJsonSchema({
    $defs: {
      tuple: {
        type: "array",
        prefixItems: [{ type: "string" }],
        items: false,
        maxItems: 1,
      },
    },
    type: "object",
    properties: { value: { $ref: "#/$defs/tuple/prefixItems/0" } },
  });
  const validateArray = compileJsonSchema({ type: "array", items: { type: "integer" } });

  expect(() => {
    validateReference({ value: "sample" });
  }).not.toThrow();
  expect(
    captureContractError(() => {
      validateArray(["private-value"]);
    }).issues,
  ).toEqual([{ path: [0], code: "json_schema_type" }]);
});

it("bounds the external schema size and keeps compile errors value-free", () => {
  expect(() => compileJsonSchema({ title: "private-schema" }, { maxBytes: 1 })).toThrow(
    ContractError,
  );

  const error = captureContractError(() => {
    compileJsonSchema({ $ref: "https://schemas.invalid/private-schema" });
  });
  expect(error.message).not.toContain("private-schema");
  expect(JSON.stringify(error.issues)).not.toContain("private-schema");
  expect(
    captureContractError(() => {
      compileJsonSchema({ type: 123 });
    }).issues,
  ).toEqual([{ path: [], code: "invalid_json_schema" }]);
});

it("rejects external schemas that cannot be serialized", () => {
  const cyclicSchema: Record<string, unknown> = {};
  cyclicSchema.self = cyclicSchema;
  const undefinedSchema: Record<string, unknown> = { toJSON: () => undefined };
  let propertyReads = 0;
  const changingSchema: Record<string, unknown> = {};
  Object.defineProperty(changingSchema, "properties", {
    enumerable: true,
    get() {
      propertyReads += 1;
      if (propertyReads > 1) {
        throw new Error("private-schema");
      }
      return {};
    },
  });

  expect(
    captureContractError(() => {
      compileJsonSchema(cyclicSchema);
    }).issues,
  ).toEqual([{ path: [], code: "invalid_json_schema" }]);
  expect(
    captureContractError(() => {
      compileJsonSchema(undefinedSchema);
    }).issues,
  ).toEqual([{ path: [], code: "invalid_json_schema" }]);
  expect(
    captureContractError(() => {
      compileJsonSchema(changingSchema);
    }).issues,
  ).toEqual([{ path: [], code: "invalid_json_schema" }]);
});

it("rejects invalid helper options with value-free errors", () => {
  expect(() => parseJson(valueSchema, "{}", { maxBytes: -1 })).toThrow(ContractError);
  expect(() => compileJsonSchema(true, { maxRefDepth: -1 })).toThrow(ContractError);
});
