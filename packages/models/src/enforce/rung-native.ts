// SPDX-License-Identifier: Apache-2.0
import { Code, safeParseJson, type ModelRequest, type Part } from "@harness/schemas";
import type { z } from "zod";
import { EnforcementIssueSchema, type EnforcementResult } from "./index.js";

/** Prepares a provider request with the schema lowered for native output. */
export function withNativeOutputSchema(
  request: ModelRequest,
  output: NonNullable<ModelRequest["output"]>,
): ModelRequest {
  return { ...request, output };
}

/** Parses the single native text response and validates it against the caller's schema. */
export function enforceNativeOutput<Schema extends z.ZodType>(
  parts: readonly Part[],
  outputSchema: Schema,
): EnforcementResult<z.output<Schema>> {
  const textParts = parts.filter((part) => part.type === "text");
  if (textParts.length !== 1 || textParts[0]?.type !== "text") {
    return {
      valid: false,
      issues: [EnforcementIssueSchema.parse({ path: [], code: Code.parse("invalid_type") })],
      rungUsed: "native",
    };
  }

  const parsed = safeParseJson(outputSchema, textParts[0].text);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map(({ path, code }) =>
        EnforcementIssueSchema.parse({ path, code: Code.parse(code) }),
      ),
      rungUsed: "native",
    };
  }
  return { value: parsed.data, valid: true, rungUsed: "native" };
}
