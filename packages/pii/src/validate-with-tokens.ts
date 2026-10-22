// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue as JsonValueSchema,
  type Code as CodeType,
  type Id,
  type JsonValue,
} from "@harness/schemas";
import { findTokens, type AuditingVaultResolver, type VaultAuditHandler } from "@harness/vault";
import { z } from "zod";

/** A value-free validation issue. */
export const TokenValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: Code,
  })
  .strict();

/** Inferred value-free validation issue. */
export type TokenValidationIssue = z.infer<typeof TokenValidationIssueSchema>;

function validateWithTokensSuccessSchema<Schema extends z.ZodType>(_schema: Schema) {
  return z
    .object({
      ok: z.literal(true),
      tokenized: JsonValueSchema,
      // The caller schema already parsed this value; validating it again could rerun transforms.
      raw: z.custom<z.output<Schema>>().optional(),
    })
    .strict();
}

function validateWithTokensFailureSchema() {
  return z
    .object({
      ok: z.literal(false),
      issues: z.array(TokenValidationIssueSchema),
    })
    .strict();
}

/** Creates the runtime contract for token-aware validation results. */
export function createValidateWithTokensResultSchema<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodDiscriminatedUnion<
  [
    ReturnType<typeof validateWithTokensSuccessSchema<Schema>>,
    ReturnType<typeof validateWithTokensFailureSchema>,
  ],
  "ok"
> {
  return z.discriminatedUnion("ok", [
    validateWithTokensSuccessSchema(schema),
    validateWithTokensFailureSchema(),
  ]);
}

/** Result of validating a tokenized JSON value against a Zod schema. */
export type ValidateWithTokensResult<Schema extends z.ZodType> = z.infer<
  ReturnType<typeof createValidateWithTokensResultSchema<Schema>>
>;

/** Options for validating tokenized output using a run-scoped, audited resolver. */
export interface ValidateWithTokensOptions {
  readonly runId: Id;
  readonly resolver: AuditingVaultResolver;
  readonly toolId?: CodeType;
  readonly onAudit?: VaultAuditHandler;
  /**
   * Return the parsed raw value only for a necessary caller. Prefer detokenizeArgs and its
   * allowlisted tool argument pointers whenever possible.
   */
  readonly wantRaw?: boolean;
}

class VaultAuditRecordingError extends Error {
  constructor(readonly failure: unknown) {
    super("Vault audit recording failed.");
  }
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
  const resultSchema = createValidateWithTokensResultSchema(schema);
  const input = JsonValueSchema.safeParse(tokenizedValue);
  if (!input.success) {
    return resultSchema.parse({
      ok: false,
      issues: toTokenValidationIssues(input.error.issues, null),
    });
  }

  const resolved = await resolveValue(input.data, [], options);
  if (resolved.issues.length > 0) {
    return resultSchema.parse({ ok: false, issues: resolved.issues });
  }

  try {
    const parsed = schema.safeParse(resolved.value);
    if (!parsed.success) {
      return resultSchema.parse({
        ok: false,
        issues: toTokenValidationIssues(parsed.error.issues, input.data),
      });
    }
    return options.wantRaw === true
      ? resultSchema.parse({ ok: true, tokenized: input.data, raw: parsed.data })
      : resultSchema.parse({ ok: true, tokenized: input.data });
  } catch {
    return resultSchema.parse({
      ok: false,
      issues: [{ path: [], code: Code.parse("custom") }],
    });
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
      {
        boundary: "tool_input",
        ...(options.toolId === undefined ? {} : { toolId: options.toolId }),
      },
      options.onAudit === undefined
        ? undefined
        : async (audit) => {
            try {
              await options.onAudit?.(audit);
            } catch (failure) {
              throw new VaultAuditRecordingError(failure);
            }
          },
    );
  } catch (error) {
    // Audit persistence failures are execution failures, never user-data validation failures.
    if (error instanceof VaultAuditRecordingError) {
      throw error.failure;
    }
    return { value, issues: [{ path, code: Code.parse("pii_token_unresolvable") }] };
  }
  if (
    resolvedValues.length !== matches.length ||
    resolvedValues.some((item) => item === undefined)
  ) {
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
  tokenizedValue: JsonValue | null,
): TokenValidationIssue[] {
  return issues.map((issue) =>
    TokenValidationIssueSchema.parse({
      path: tokenizedPath(issue.path, tokenizedValue),
      code: issue.code,
    }),
  );
}

function tokenizedPath(path: readonly PropertyKey[], tokenizedValue: JsonValue | null) {
  const safePath: (string | number)[] = [];
  let current: JsonValue | undefined = tokenizedValue ?? undefined;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (Number.isInteger(segment) && segment >= 0 && segment < current.length) {
        safePath.push(segment);
        current = current[segment];
      } else {
        safePath.push("*");
        current = undefined;
      }
    } else if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      typeof segment === "string" &&
      Object.hasOwn(current, segment)
    ) {
      safePath.push(segment);
      current = current[segment];
    } else {
      safePath.push("*");
      current = undefined;
    }
  }
  return safePath;
}
