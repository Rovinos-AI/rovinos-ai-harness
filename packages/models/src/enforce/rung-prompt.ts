// SPDX-License-Identifier: Apache-2.0
import { Code, type ModelRequest, type Part } from "@harness/schemas";
import type { z } from "zod";
import { extractJson } from "./extract-json.js";
import {
  EnforcementIssueSchema,
  enforcementIssuesFromError,
  parseEnforcementResult,
  type EnforcementResult,
} from "./index.js";

/** Adds a schema-specific JSON instruction to the request's system messages. */
export function withPromptOutput(
  request: ModelRequest,
  output: NonNullable<ModelRequest["output"]>,
): ModelRequest {
  const instruction = `Respond with a single JSON value matching this JSON Schema. Do not include commentary.\n${JSON.stringify(output.schema)}`;
  return {
    ...request,
    messages: [
      { role: "system", parts: [{ type: "text", text: instruction }] },
      ...request.messages,
    ],
    output,
  };
}

/** Extracts a JSON value from the single model text part and validates it against the caller schema. */
export function enforcePromptOutput<Schema extends z.ZodType>(
  parts: readonly Part[],
  outputSchema: Schema,
): EnforcementResult<Schema> {
  if (parts.some((part) => part.type === "tool_call")) {
    return parseEnforcementResult(outputSchema, {
      valid: false,
      issues: [
        EnforcementIssueSchema.parse({ path: [], code: Code.parse("unexpected_tool_call") }),
      ],
      rungUsed: "prompt",
    });
  }
  const textParts = parts.filter((part) => part.type === "text");
  if (textParts.length !== 1 || textParts[0]?.type !== "text") {
    return parseEnforcementResult(outputSchema, {
      valid: false,
      issues: [EnforcementIssueSchema.parse({ path: [], code: Code.parse("invalid_type") })],
      rungUsed: "prompt",
    });
  }

  const extracted = extractJson(textParts[0].text);
  if (!extracted.ok) {
    return parseEnforcementResult(outputSchema, {
      valid: false,
      issues: [
        EnforcementIssueSchema.parse({
          path: [],
          code: Code.parse(extracted.code),
        }),
      ],
      rungUsed: "prompt",
    });
  }

  const parsed = outputSchema.safeParse(extracted.value);
  if (!parsed.success) {
    return parseEnforcementResult(outputSchema, {
      valid: false,
      issues: enforcementIssuesFromError(parsed.error),
      rungUsed: "prompt",
    });
  }
  return parseEnforcementResult(outputSchema, {
    value: parsed.data,
    valid: true,
    rungUsed: "prompt",
  });
}
