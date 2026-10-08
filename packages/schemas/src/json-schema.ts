// SPDX-License-Identifier: Apache-2.0
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormats from "ajv-formats";
import { z } from "zod";
import { ContractError, parseJson, type ContractIssue } from "./parse.js";

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
const jsonSchemaSnapshot = z.union([z.boolean(), z.record(z.string(), z.unknown())]);
const DEFAULT_SCHEMA_URI = "https://json-schema.invalid/root";

interface ReferenceAnalysis {
  readonly resources: Map<string, unknown>;
  readonly referencesBySchema: Map<Record<string, unknown>, string[]>;
  readonly references: string[];
  readonly hasRemoteReferences: boolean;
}

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

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resourceUri(baseUri: string, id?: string): string {
  const uri = new URL(id ?? baseUri, baseUri);
  uri.hash = "";
  return uri.href;
}

function analyzeReferences(schema: unknown): ReferenceAnalysis {
  const resources = new Map<string, unknown>();
  const referencesBySchema = new Map<Record<string, unknown>, string[]>();
  const references: string[] = [];
  const pending: { schema: unknown; baseUri: string; isRoot: boolean }[] = [
    { schema, baseUri: DEFAULT_SCHEMA_URI, isRoot: true },
  ];
  const visited = new Set<unknown>();
  let hasRemoteReferences = false;

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined || !isRecord(entry.schema) || visited.has(entry.schema)) {
      continue;
    }
    const current = entry.schema;
    visited.add(current);
    const id = current.$id;
    const uri = resourceUri(entry.baseUri, typeof id === "string" ? id : undefined);
    if (entry.isRoot || typeof id === "string") {
      resources.set(uri, current);
    }
    const currentRefs = ["$ref", "$dynamicRef"]
      .map((keyword) => current[keyword])
      .filter((ref): ref is string => typeof ref === "string");
    if (currentRefs.length > 0) {
      hasRemoteReferences ||= currentRefs.some((ref) => !ref.startsWith("#"));
      const resolvedRefs = currentRefs.map((ref) => new URL(ref, uri).href);
      referencesBySchema.set(entry.schema, resolvedRefs);
      references.push(...resolvedRefs);
    }
    pending.push(
      ...schemaChildren(current).map((child) => ({ schema: child, baseUri: uri, isRoot: false })),
    );
  }

  return { resources, referencesBySchema, references, hasRemoteReferences };
}

function resolvePointer(root: unknown, fragment: string): unknown {
  if (fragment === "#") {
    return root;
  }
  if (!fragment.startsWith("#/")) {
    return undefined;
  }

  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment.slice(1));
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

function resolveAnchor(root: unknown, fragment: string): unknown {
  let anchor: string;
  try {
    anchor = decodeURIComponent(fragment.slice(1));
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
      pending.push(
        ...schemaChildren(current).filter(
          (child) => !isRecord(child) || typeof child.$id !== "string",
        ),
      );
    }
  }
  return undefined;
}

function resolveRef(resources: ReadonlyMap<string, unknown>, ref: string): unknown {
  let uri: URL;
  try {
    uri = new URL(ref);
  } catch {
    return undefined;
  }
  const root = resources.get(resourceUri(uri.href));
  if (root === undefined) {
    return undefined;
  }
  if (uri.hash.length === 0) {
    return root;
  }
  return uri.hash.startsWith("#/") ? resolvePointer(root, uri.hash) : resolveAnchor(root, uri.hash);
}

function refsInSchema(
  schema: unknown,
  referencesBySchema: ReadonlyMap<Record<string, unknown>, string[]>,
): string[] {
  const refs: string[] = [];
  const pending: unknown[] = [schema];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!isRecord(current) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    refs.push(...(referencesBySchema.get(current) ?? []));
    pending.push(...schemaChildren(current));
  }
  return refs;
}

function exceedsRefDepth(
  resources: ReadonlyMap<string, unknown>,
  referencesBySchema: ReadonlyMap<Record<string, unknown>, string[]>,
  refs: readonly string[],
  maxRefDepth: number,
): boolean {
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
    const target = resolveRef(resources, current.ref);
    if (target === undefined) {
      continue;
    }
    const ancestors = new Set(current.ancestors).add(current.ref);
    for (const ref of refsInSchema(target, referencesBySchema)) {
      pending.push({ ref, depth: current.depth + 1, ancestors });
    }
  }
  return false;
}

function pathFromInstancePath(
  instancePath: string,
  value: unknown,
): (string | number)[] {
  if (instancePath.length === 0) {
    return [];
  }
  let current = value;
  return instancePath.split("/").slice(1).map((encodedSegment) => {
    const segment = decodePointerSegment(encodedSegment);
    if (isUnknownArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) {
      const index = Number(segment);
      if (Number.isSafeInteger(index)) {
        current = current[index];
        return index;
      }
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      current = undefined;
    }
    return segment;
  });
}

function issuesFromAjv(
  errors: readonly ErrorObject[] | null | undefined,
  value: unknown,
): ContractIssue[] {
  return (
    errors?.map(({ instancePath, keyword }) => ({
      path: pathFromInstancePath(instancePath, value),
      code: `json_schema_${keyword}`,
    })) ?? [{ path: [], code: "json_schema_invalid" }]
  );
}

function normalizeJsonSchema(jsonSchema: unknown, maxBytes: number): AnySchema {
  if (!isJsonSchema(jsonSchema)) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(jsonSchema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (typeof serialized !== "string") {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }

  let normalizedSchema: unknown;
  try {
    normalizedSchema = parseJson(jsonSchemaSnapshot, serialized, { maxBytes });
  } catch (error) {
    if (
      error instanceof ContractError &&
      error.issues.some(({ code }) => code === "size_limit_exceeded")
    ) {
      throw error;
    }
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (!isJsonSchema(normalizedSchema)) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  return normalizedSchema;
}

function checkReferenceBounds(schema: AnySchema, maxRefDepth: number): void {
  let analysis: ReferenceAnalysis;
  try {
    analysis = analyzeReferences(schema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (analysis.hasRemoteReferences) {
    throw new ContractError([{ path: [], code: "remote_ref_disallowed" }]);
  }

  let refDepthExceeded: boolean;
  try {
    refDepthExceeded = exceedsRefDepth(
      analysis.resources,
      analysis.referencesBySchema,
      analysis.references,
      maxRefDepth,
    );
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  if (refDepthExceeded) {
    throw new ContractError([{ path: [], code: "ref_depth_exceeded" }]);
  }
}

function compileValidator(schema: AnySchema): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: false,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    addUsedSchema: false,
    logger: false,
  });
  ajv.addKeyword({ keyword: "$anchor", schemaType: "string", valid: true });
  const formatsPlugin: unknown = addFormats.default;
  if (!isFormatsPlugin(formatsPlugin)) {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
  formatsPlugin(ajv);
  try {
    return ajv.compile(schema);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json_schema" }]);
  }
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
  const normalizedSchema = normalizeJsonSchema(jsonSchema, maxBytes);
  checkReferenceBounds(normalizedSchema, maxRefDepth);
  const validate = compileValidator(normalizedSchema);

  return (value: unknown): void => {
    let valid: boolean;
    try {
      valid = validate(value);
    } catch {
      throw new ContractError([{ path: [], code: "json_schema_invalid" }]);
    }
    if (!valid) {
      throw new ContractError(issuesFromAjv(validate.errors, value));
    }
  };
}
