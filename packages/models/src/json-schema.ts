// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, Id, JsonValue, Sha256Hex } from "@harness/schemas";
import { createHash } from "node:crypto";
import { z } from "zod";
import { providerSchemaRules, type ProviderSchemaRule } from "./provider-schema-rules.js";

const jsonSchemaSchema = z.record(z.string(), JsonValue);
const jsonSchemaErrorCodeSchema = z.enum([
  "schema_conversion_failed",
  "schema_provider_unsupported",
  "schema_recursive_unsupported",
]);
const schemaMapKeywords = [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
];
const schemaArrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaSingleKeywords = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const schemaBearingKeywords = new Set([
  ...schemaMapKeywords,
  ...schemaArrayKeywords,
  ...schemaSingleKeywords,
]);

/** JSON Schema object produced by the Zod conversion and lowering helpers. */
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

/** A stable schema conversion or provider compatibility error. */
export class JsonSchemaError extends HarnessError {
  readonly code: z.infer<typeof jsonSchemaErrorCodeSchema>;

  /**
   * Creates a stable schema error without retaining provider or schema data.
   *
   * @param code - Closed error code for the conversion failure.
   */
  constructor(code: z.infer<typeof jsonSchemaErrorCodeSchema>) {
    super(code);
    this.code = jsonSchemaErrorCodeSchema.parse(code);
  }
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonSchema(value: unknown): JsonSchema {
  try {
    return jsonSchemaSchema.parse(value);
  } catch {
    throw new JsonSchemaError("schema_conversion_failed");
  }
}

function isSchemaNode(value: JsonValue): boolean {
  return typeof value === "boolean" || isJsonObject(value);
}

function nullableConstraint(
  schema: Record<string, JsonValue>,
  type: JsonValue | undefined,
): JsonValue | undefined {
  const typeAllowsNull =
    type === undefined || type === "null" || (Array.isArray(type) && type.includes("null"));
  if ("const" in schema) {
    return schema.const === null && typeAllowsNull ? schema : { anyOf: [schema, { type: "null" }] };
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    return enumValues.includes(null) && typeAllowsNull
      ? schema
      : { anyOf: [schema, { type: "null" }] };
  }
  return undefined;
}

function containsReference(value: JsonValue): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  if ("$ref" in value) {
    return true;
  }

  for (const keyword of schemaMapKeywords) {
    const children = value[keyword];
    if (
      isJsonObject(children) &&
      Object.values(children).some((child) => isSchemaNode(child) && containsReference(child))
    ) {
      return true;
    }
  }
  for (const keyword of schemaArrayKeywords) {
    const children = value[keyword];
    if (
      Array.isArray(children) &&
      children.some((child) => isSchemaNode(child) && containsReference(child))
    ) {
      return true;
    }
  }
  for (const keyword of schemaSingleKeywords) {
    const child = value[keyword];
    if (child !== undefined && isSchemaNode(child) && containsReference(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Converts a Zod schema to an inline Draft 2020-12 JSON Schema object.
 *
 * @param schema - Zod schema to convert using its accepted input shape.
 * @returns A JSON Schema object without `$schema` or `$ref`.
 * @throws JsonSchemaError with `schema_recursive_unsupported` for recursive schemas.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  let converted: unknown;
  try {
    converted = z.toJSONSchema(schema, {
      cycles: "ref",
      io: "input",
      reused: "inline",
      target: "draft-2020-12",
    });
  } catch {
    throw new JsonSchemaError("schema_conversion_failed");
  }

  const result = parseJsonSchema(converted);
  if (containsReference(result)) {
    throw new JsonSchemaError("schema_recursive_unsupported");
  }
  delete result.$schema;
  return result;
}

const idCodePatterns = new Set(
  [Id, Code].map((schema) => {
    const pattern = toJsonSchema(schema).pattern;
    if (typeof pattern !== "string") {
      throw new JsonSchemaError("schema_conversion_failed");
    }
    return pattern;
  }),
);

function nullableSchema(schema: JsonValue): JsonValue {
  if (schema === true) {
    return schema;
  }
  if (schema === false) {
    return { anyOf: [false, { type: "null" }] };
  }
  if (!isJsonObject(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }

  const type = schema.type;
  if (type === "null") {
    return schema;
  }
  const constrained = nullableConstraint(schema, type);
  if (constrained !== undefined) {
    return constrained;
  }
  if (typeof type === "string") {
    return { ...schema, type: [type, "null"] };
  }
  if (Array.isArray(type) && type.every((entry) => typeof entry === "string")) {
    if (type.includes("null")) {
      return schema;
    }
    return { ...schema, type: [...type, "null"] };
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.some(isNullSchema)) {
    return schema;
  }
  return { anyOf: [schema, { type: "null" }] };
}

function isNullSchema(value: JsonValue): boolean {
  return isJsonObject(value) && value.type === "null";
}

function isObjectSchema(schema: Record<string, JsonValue>): boolean {
  const type = schema.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    schema.properties !== undefined
  );
}

function droppedCode(keyword: string): Code | undefined {
  const normalized = (keyword.startsWith("$") ? `schema_${keyword.slice(1)}` : keyword)
    .replaceAll(/([A-Z])/gu, "_$1")
    .toLowerCase();
  const code = Code.safeParse(normalized);
  return code.success ? code.data : undefined;
}

function lowerKeywordValue(
  keyword: string,
  value: JsonValue,
  rules: ProviderSchemaRule,
  dropped: Set<string>,
): JsonValue {
  if (schemaMapKeywords.includes(keyword) && isJsonObject(value)) {
    const schemas: Record<string, JsonValue> = {};
    for (const [name, child] of Object.entries(value)) {
      schemas[name] = isSchemaNode(child) ? lowerSchemaNode(child, rules, dropped) : child;
    }
    return schemas;
  }
  if (schemaArrayKeywords.includes(keyword) && Array.isArray(value)) {
    return value.map((child) => {
      if (!isSchemaNode(child)) {
        return child;
      }
      return lowerSchemaNode(child, rules, dropped);
    });
  }
  if (schemaSingleKeywords.includes(keyword) && isSchemaNode(value)) {
    return lowerSchemaNode(value, rules, dropped);
  }
  return value;
}

function isTrivialPropertyNames(schema: JsonValue): boolean {
  return isJsonObject(schema) && schema.type === "string" && Object.keys(schema).length === 1;
}

function lowerOneOf(
  child: JsonValue,
  schema: Record<string, JsonValue>,
  rules: ProviderSchemaRule,
  dropped: Set<string>,
): JsonValue[] {
  if (!Array.isArray(child) || !rules.allowedKeywords.includes("anyOf") || "anyOf" in schema) {
    throw new JsonSchemaError("schema_provider_unsupported");
  }
  const code = droppedCode("oneOf");
  if (code !== undefined) {
    dropped.add(code);
  }
  return child.map((entry) => lowerSchemaNode(entry, rules, dropped));
}

function recordDroppedKeyword(keyword: string, dropped: Set<string>): void {
  if (schemaBearingKeywords.has(keyword)) {
    throw new JsonSchemaError("schema_provider_unsupported");
  }
  const code = droppedCode(keyword);
  if (code !== undefined) {
    dropped.add(code);
  }
}

function lowerSchemaNode(
  schema: JsonValue,
  rules: ProviderSchemaRule,
  dropped: Set<string>,
): JsonValue {
  if (!isJsonObject(schema)) {
    return schema;
  }

  const lowered: Record<string, JsonValue> = {};
  for (const [keyword, child] of Object.entries(schema)) {
    if (keyword === "propertyNames" && isTrivialPropertyNames(child)) {
      continue;
    }
    if (keyword === "oneOf") {
      lowered.anyOf = lowerOneOf(child, schema, rules, dropped);
      continue;
    }
    const supportedPattern =
      keyword !== "pattern" || (typeof child === "string" && idCodePatterns.has(child));
    if (!rules.allowedKeywords.includes(keyword) || !supportedPattern) {
      recordDroppedKeyword(keyword, dropped);
      continue;
    }
    lowered[keyword] = lowerKeywordValue(keyword, child, rules, dropped);
  }
  return lowerObject(lowered, rules.requireAllProperties, rules.requireAdditionalPropertiesFalse);
}

function lowerObject(
  schema: Record<string, JsonValue>,
  requireAllProperties: boolean,
  requireAdditionalPropertiesFalse: boolean,
): Record<string, JsonValue> {
  if (!isObjectSchema(schema)) {
    return schema;
  }

  const result: Record<string, JsonValue> = { ...schema };
  const properties = result.properties;
  if (requireAllProperties && isJsonObject(properties)) {
    const required = new Set(
      Array.isArray(result.required)
        ? result.required.filter((value): value is string => typeof value === "string")
        : [],
    );
    const loweredProperties: Record<string, JsonValue> = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      loweredProperties[name] = required.has(name)
        ? propertySchema
        : nullableSchema(propertySchema);
    }
    result.properties = loweredProperties;
    result.required = Object.keys(loweredProperties).sort();
  }
  if (requireAdditionalPropertiesFalse) {
    if (
      (result.additionalProperties !== undefined && result.additionalProperties !== false) ||
      (!isJsonObject(properties) && result.additionalProperties !== false)
    ) {
      throw new JsonSchemaError("schema_provider_unsupported");
    }
    result.additionalProperties = false;
  }
  return result;
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalJson(value: JsonValue, parentKey?: string): string {
  if (Array.isArray(value)) {
    const items = ["required", "type"].includes(parentKey ?? "")
      ? [...value].sort((left, right) => compareOrdinal(canonicalJson(left), canonicalJson(right)))
      : value;
    return `[${items.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const entry = value[key];
        if (entry === undefined) {
          throw new JsonSchemaError("schema_conversion_failed");
        }
        return `${JSON.stringify(key)}:${canonicalJson(entry, key)}`;
      });
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

/**
 * Lowers a Zod schema or JSON Schema object to a provider's supported keyword subset.
 *
 * @param schema - Zod schema or an already converted JSON Schema object.
 * @param provider - Provider id with registered compatibility rules.
 * @returns The lowered schema and sorted unique Code names for removed keywords; camelCase names
 * are normalized to snake_case.
 * @throws JsonSchemaError when conversion fails, the schema is recursive, or the provider is unknown.
 */
export function lowerForProvider(
  schema: z.ZodType | JsonSchema,
  provider: string,
): { readonly schema: JsonSchema; readonly dropped: Code[] } {
  const rules = providerSchemaRules(provider);
  if (rules === undefined) {
    throw new JsonSchemaError("schema_provider_unsupported");
  }

  const jsonSchema = schema instanceof z.ZodType ? toJsonSchema(schema) : parseJsonSchema(schema);
  if (containsReference(jsonSchema)) {
    throw new JsonSchemaError("schema_recursive_unsupported");
  }
  const dropped = new Set<string>();
  const lowered = lowerSchemaNode(jsonSchema, rules, dropped);
  return {
    schema: parseJsonSchema(lowered),
    dropped: [...dropped].sort().map((keyword) => Code.parse(keyword)),
  };
}

/**
 * Hashes a JSON Schema using SHA-256 over canonical JSON with sorted object keys.
 *
 * @param jsonSchema - JSON Schema object to hash.
 * @returns Lowercase SHA-256 hex digest.
 */
export function schemaHash(jsonSchema: JsonSchema): z.infer<typeof Sha256Hex> {
  const parsed = parseJsonSchema(jsonSchema);
  return Sha256Hex.parse(createHash("sha256").update(canonicalJson(parsed)).digest("hex"));
}
