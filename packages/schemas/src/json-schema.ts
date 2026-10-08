// SPDX-License-Identifier: Apache-2.0
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormats from "ajv-formats";
import { z } from "zod";
import { ContractError, type ContractIssue } from "./parse.js";

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_REF_DEPTH = 16;
const compileOptionsSchema = z
  .object({
    maxRefDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const schemaMapKeywords = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
];
const schemaArrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singleSchemaKeywords = [
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

/** Bounds applied when compiling an external JSON Schema. */
export type CompileJsonSchemaOptions = z.infer<typeof compileOptionsSchema>;

/** A compiled external JSON Schema validator that throws value-free contract errors. */
export type JsonSchemaValidator = (value: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isJsonSchema(value: unknown): value is AnySchema {
  return typeof value === "boolean" || isRecord(value);
}

function isFormatsPlugin(value: unknown): value is (ajv: Ajv2020) => unknown {
  return typeof value === "function";
}

function schemaChildren(schema: Record<string, unknown>): unknown[] {
  const children: unknown[] = [];
  for (const keyword of schemaMapKeywords) {
    const schemas = schema[keyword];
    if (isRecord(schemas)) {
      children.push(...Object.values(schemas).filter(isJsonSchema));
    }
  }
  for (const keyword of schemaArrayKeywords) {
    const schemas = schema[keyword];
    if (isUnknownArray(schemas)) {
      children.push(...schemas.filter(isJsonSchema));
    }
  }
  for (const keyword of singleSchemaKeywords) {
    const child = schema[keyword];
    if (isJsonSchema(child)) {
      children.push(child);
    }
  }
  return children;
}

function issueFromOptions(error: z.ZodError): ContractIssue[] {
  return error.issues.map(({ path, code }) => ({
    path: path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    code,
  }));
}

function collectRefs(schema: unknown): string[] {
  const refs: string[] = [];
  const pending: unknown[] = [schema];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (isUnknownArray(current)) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      pending.push(...current);
    } else if (isRecord(current)) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const keyword of ["$ref", "$dynamicRef"]) {
        const ref = current[keyword];
        if (typeof ref === "string") {
          refs.push(ref);
        }
      }
      pending.push(...schemaChildren(current));
    }
  }
  return refs;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }

  let current = root;
  for (const segment of pointer.split("/").slice(1).map(decodePointerSegment)) {
    if (isUnknownArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveAnchor(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#") || ref.startsWith("#/")) {
    return undefined;
  }
  let anchor: string;
  try {
    anchor = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  const pending: unknown[] = [root];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (isUnknownArray(current)) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      pending.push(...current);
    } else if (isRecord(current)) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      if (current.$anchor === anchor || current.$dynamicAnchor === anchor) {
        return current;
      }
      pending.push(...schemaChildren(current));
    }
  }
  return undefined;
}

function resolveRef(root: unknown, ref: string): unknown {
  return ref.startsWith("#/") || ref === "#" ? resolvePointer(root, ref) : resolveAnchor(root, ref);
}

function exceedsRefDepth(root: unknown, refs: readonly string[], maxRefDepth: number): boolean {
  const pending = refs.map((ref) => ({ ref, depth: 1, ancestors: new Set<string>() }));
  const processedDepth = new Map<string, number>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (current.ancestors.has(current.ref)) {
      continue;
    }
    if (current.depth > maxRefDepth) {
      return true;
    }
    if (current.depth <= (processedDepth.get(current.ref) ?? 0)) {
      continue;
    }
    processedDepth.set(current.ref, current.depth);
    const target = resolveRef(root, current.ref);
    if (target === undefined) {
      continue;
    }
    const ancestors = new Set(current.ancestors).add(current.ref);
    for (const ref of collectRefs(target)) {
      pending.push({ ref, depth: current.depth + 1, ancestors });
    }
  }
  return false;
}

function pathFromInstancePath(instancePath: string): (string | number)[] {
  if (instancePath.length === 0) {
    return [];
  }
  return instancePath
    .split("/")
    .slice(1)
    .map(decodePointerSegment)
    .map((segment) => {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return segment;
      }
      const index = Number(segment);
      return Number.isSafeInteger(index) ? index : segment;
    });
}

function issuesFromAjv(errors: readonly ErrorObject[] | null | undefined): ContractIssue[] {
  return (
    errors?.map(({ instancePath, keyword }) => ({
      path: pathFromInstancePath(instancePath),
      code: `json_schema_${keyword}`,
    })) ?? [{ path: [], code: "json_schema_invalid" }]
  );
}

/**
 * Compiles a bounded, external JSON Schema using the 2020-12 dialect.
 *
 * @param jsonSchema - External schema, such as an MCP tool schema.
 * @param options - Limits for schema size and local reference depth; defaults are 1 MiB and 16 refs.
 * @returns A validator that throws {@link ContractError} on invalid values.
 * @throws ContractError for invalid options or schemas, remote references, and size/ref limits.
 */
export function compileJsonSchema(
  jsonSchema: unknown,
  options: CompileJsonSchemaOptions = {},
): JsonSchemaValidator {
  const optionResult = compileOptionsSchema.safeParse(options);
  if (!optionResult.success) {
    throw new ContractError(issueFromOptions(optionResult.error));
  }
  const maxBytes = optionResult.data.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRefDepth = optionResult.data.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH;

  if (!isJsonSchema(jsonSchema)) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }

  let serialized: unknown;
  try {
    serialized = JSON.stringify(jsonSchema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (typeof serialized !== "string") {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new ContractError([{ path: [], code: "size_limit_exceeded" }]);
  }

  let refs: string[];
  try {
    refs = collectRefs(jsonSchema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (refs.some((ref) => !ref.startsWith("#"))) {
    throw new ContractError([{ path: [], code: "remote_ref_disallowed" }]);
  }
  let refDepthExceeded: boolean;
  try {
    refDepthExceeded = exceedsRefDepth(jsonSchema, refs, maxRefDepth);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (refDepthExceeded) {
    throw new ContractError([{ path: [], code: "ref_depth_exceeded" }]);
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true, addUsedSchema: false });
  ajv.addKeyword({ keyword: "$anchor", schemaType: "string", valid: true });
  const formatsPlugin: unknown = addFormats.default;
  if (!isFormatsPlugin(formatsPlugin)) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  formatsPlugin(ajv);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(jsonSchema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }

  return (value: unknown): void => {
    let valid: boolean;
    try {
      valid = validate(value);
    } catch {
      throw new ContractError([{ path: [], code: "json_schema_invalid" }]);
    }
    if (!valid) {
      throw new ContractError(issuesFromAjv(validate.errors));
    }
  };
}
