// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue as JsonValueSchema,
  type Id,
  type JsonValue,
} from "@harness/schemas";
import { findTokens, type AuditingVaultResolver } from "@harness/vault";
import type { z } from "zod";

/** A value-free validation issue. */
export interface TokenValidationIssue {
  readonly path: (string | number)[];
  readonly code: Code;
}

/** Result of validating a tokenized JSON value against a Zod schema. */
export type ValidateWithTokensResult<Schema extends z.ZodType> =
  | { readonly ok: true; readonly tokenized: JsonValue; readonly raw?: z.output<Schema> }
  | { readonly ok: false; readonly issues: TokenValidationIssue[] };

/** Options for validating tokenized output using a run-scoped, audited resolver. */
export interface ValidateWithTokensOptions {
  readonly runId: Id;
  readonly resolver: AuditingVaultResolver;
  /**
   * Return the parsed raw value only for a necessary caller. Prefer detokenizeArgs and its
   * allowlisted tool argument pointers whenever possible.
   */
  readonly wantRaw?: boolean;
}

/**
 * Validate structured JSON containing run-scoped tokens without changing its tokenized form.
 *
 * Token values are resolved in a detached in-memory copy and every resolution uses the audited
 * `tool_input` boundary. Validation failures expose paths and codes only.
 *
 * @param schema - Zod schema applied to the temporary resolved copy.
 * @param tokenizedValue - Original JSON value to preserve and return.
 * @param options - Run identifier, auditing resolver, and optional audited raw-value access.
 * @returns The original tokenized value on success, or value-free issue paths and codes.
 */
export async function validateWithTokens<Schema extends z.ZodType>(
  schema: Schema,
  tokenizedValue: JsonValue,
  options: ValidateWithTokensOptions,
): Promise<ValidateWithTokensResult<Schema>> {
  const input = JsonValueSchema.safeParse(tokenizedValue);
  if (!input.success) {
    return { ok: false, issues: toTokenValidationIssues(input.error.issues) };
  }

  const resolved = await resolveValue(input.data, [], options);
  if (resolved.issues.length > 0) {
    return { ok: false, issues: resolved.issues };
  }

  try {
    const parsed = schema.safeParse(resolved.value);
    if (!parsed.success) {
      return { ok: false, issues: toTokenValidationIssues(parsed.error.issues) };
    }
    return options.wantRaw === true
      ? { ok: true, tokenized: tokenizedValue, raw: parsed.data }
      : { ok: true, tokenized: tokenizedValue };
  } catch {
    return { ok: false, issues: [{ path: [], code: Code.parse("custom") }] };
  }
}

interface ResolvedValue {
  readonly value: JsonValue;
  readonly issues: TokenValidationIssue[];
}

async function resolveValue(
  value: JsonValue,
  path: (string | number)[],
  options: ValidateWithTokensOptions,
): Promise<ResolvedValue> {
  if (typeof value === "string") {
    return resolveString(value, path, options);
  }
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    const issues: TokenValidationIssue[] = [];
    for (const [index, child] of value.entries()) {
      const resolved = await resolveValue(child, [...path, index], options);
      values.push(resolved.value);
      issues.push(...resolved.issues);
    }
    return { value: values, issues };
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    const issues: TokenValidationIssue[] = [];
    for (const [key, child] of Object.entries(value)) {
      const resolved = await resolveValue(child, [...path, key], options);
      Object.defineProperty(copy, key, {
        value: resolved.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      issues.push(...resolved.issues);
    }
    return { value: copy, issues };
  }
  return { value, issues: [] };
}

async function resolveString(
  value: string,
  path: (string | number)[],
  options: ValidateWithTokensOptions,
): Promise<ResolvedValue> {
  const matches = findTokens(value);
  if (matches.length === 0) {
    return { value, issues: [] };
  }

  let resolvedValues: (string | undefined)[];
  try {
    resolvedValues = await options.resolver.resolveMany(
      options.runId,
      matches.map(({ token }) => token),
      { boundary: "tool_input" },
    );
  } catch {
    return { value, issues: [{ path, code: Code.parse("pii_token_unresolvable") }] };
  }
  if (resolvedValues.length !== matches.length || resolvedValues.some((item) => item === undefined)) {
    return { value, issues: [{ path, code: Code.parse("pii_token_unresolvable") }] };
  }

  let result = "";
  let offset = 0;
  for (const [index, match] of matches.entries()) {
    result += value.slice(offset, match.index);
    result += resolvedValues[index] ?? match.token;
    offset = match.index + match.token.length;
  }
  return { value: result + value.slice(offset), issues: [] };
}

function toTokenValidationIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[],
): TokenValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    ),
    code: Code.parse(issue.code),
  }));
}
