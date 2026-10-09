// SPDX-License-Identifier: Apache-2.0
import { parse as parseYamlDocument } from "yaml";
import { z } from "zod";
import { HarnessError } from "./errors.js";

const DEFAULT_MAX_BYTES = 1_048_576;
const parseOptionsSchema = z
  .object({
    maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const contractIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: z.string().min(1),
  })
  .strict();

/** One value-free contract validation issue. */
export type ContractIssue = z.infer<typeof contractIssueSchema>;

/** Safe error for invalid contract input; it never retains input values or parser messages. */
export class ContractError extends HarnessError {
  readonly code = "contract_invalid";
  readonly issues: readonly ContractIssue[];

  /**
   * Creates a contract error from issue paths and codes only.
   *
   * @param issues - Paths and codes for the validation failures.
   */
  constructor(issues: readonly ContractIssue[]) {
    super("Contract validation failed.");
    this.name = "ContractError";
    this.issues = issues.map(({ path, code }) =>
      contractIssueSchema.parse({ path: [...path], code }),
    );
  }
}

/** Options shared by the JSON and YAML parsers. */
export type ParseOptions = z.infer<typeof parseOptionsSchema>;

/** Result returned by {@link safeParseJson}. */
export type SafeParseJsonResult<Schema extends z.ZodType> =
  | { readonly success: true; readonly data: z.infer<Schema> }
  | { readonly success: false; readonly error: ContractError };

function issuesFromZod(error: z.ZodError): ContractIssue[] {
  return error.issues.map(({ path, code }) => ({
    path: path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    code,
  }));
}

function maxBytesFor(options: ParseOptions): number {
  const result = parseOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new ContractError(issuesFromZod(result.error));
  }
  return result.data.maxBytes ?? DEFAULT_MAX_BYTES;
}

function withinByteLimit(text: string, maxBytes: number): boolean {
  return new TextEncoder().encode(text).byteLength <= maxBytes;
}

function validate<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  let issues: ContractIssue[];
  try {
    const result = schema.safeParse(input);
    if (result.success) {
      return result.data;
    }
    issues = issuesFromZod(result.error);
  } catch {
    throw new ContractError([{ path: [], code: "validation_failed" }]);
  }
  throw new ContractError(issues);
}

/**
 * Parses and validates JSON text with a Zod schema.
 *
 * @param schema - The schema defining the contract.
 * @param text - Untrusted JSON text.
 * @param options - Optional UTF-8 byte limit (defaults to 1 MiB).
 * @returns The schema-inferred output.
 * @throws ContractError when parsing, size, options, or validation fails.
 */
export function parseJson<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  options: ParseOptions = {},
): z.infer<Schema> {
  if (!withinByteLimit(text, maxBytesFor(options))) {
    throw new ContractError([{ path: [], code: "size_limit_exceeded" }]);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_json" }]);
  }
  return validate(schema, input);
}

/**
 * Parses and validates YAML text with a Zod schema.
 *
 * @param schema - The schema defining the contract.
 * @param text - Untrusted YAML text.
 * @param options - Optional UTF-8 byte limit (defaults to 1 MiB).
 * @returns The schema-inferred output.
 * @throws ContractError when parsing, size, options, or validation fails.
 */
export function parseYaml<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  options: ParseOptions = {},
): z.infer<Schema> {
  if (!withinByteLimit(text, maxBytesFor(options))) {
    throw new ContractError([{ path: [], code: "size_limit_exceeded" }]);
  }

  let input: unknown;
  try {
    input = parseYamlDocument(text);
  } catch {
    throw new ContractError([{ path: [], code: "invalid_yaml" }]);
  }
  return validate(schema, input);
}

/**
 * Parses JSON text without throwing for contract input failures.
 *
 * @param schema - The schema defining the contract.
 * @param text - Untrusted JSON text.
 * @param options - Optional UTF-8 byte limit (defaults to 1 MiB).
 * @returns A discriminated success result or a value-free contract error.
 */
export function safeParseJson<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  options: ParseOptions = {},
): SafeParseJsonResult<Schema> {
  try {
    return { success: true, data: parseJson(schema, text, options) };
  } catch (error) {
    if (error instanceof ContractError) {
      return { success: false, error };
    }
    throw error;
  }
}
