// SPDX-License-Identifier: Apache-2.0
import { Code, JsonValue, type ModelRequest, type Part } from "@harness/schemas";
import type { z } from "zod";
import {
  applyValueTransform,
  EnforcementIssueSchema,
  enforcementIssuesFromError,
  parseEnforcementResult,
  parseTokenizedEnforcementResult,
  stripSyntheticToolCall,
  type EnforcementResult,
  type ValueTransform,
} from "./index.js";

const SYNTHETIC_TOOL_ID = Code.parse("emit_result");

/** Replaces model tools with a forced synthetic tool carrying the lowered result schema. */
export function withForcedOutputTool(
  request: ModelRequest,
  output: NonNullable<ModelRequest["output"]>,
): ModelRequest {
  return {
    ...request,
    output,
    tools: [
      {
        toolId: SYNTHETIC_TOOL_ID,
        description: "Emit the requested structured result.",
        inputSchema: output.schema,
      },
    ],
    toolChoice: { forced: SYNTHETIC_TOOL_ID },
  };
}

/** Validates the synthetic tool arguments and removes the synthetic call from response parts. */
export async function enforceToolOutput<Schema extends z.ZodType>(
  parts: readonly Part[],
  outputSchema: Schema,
  valueTransform?: ValueTransform,
): Promise<{
  readonly parts: Part[];
  readonly result: EnforcementResult<Schema>;
}> {
  const calls = parts.filter(
    (part) => part.type === "tool_call" && part.toolId === SYNTHETIC_TOOL_ID,
  );
  const withoutSyntheticCall = stripSyntheticToolCall(parts);
  if (calls.length !== 1 || calls[0]?.type !== "tool_call") {
    return {
      parts: withoutSyntheticCall,
      result: parseEnforcementResult(outputSchema, {
        valid: false,
        issues: [EnforcementIssueSchema.parse({ path: [], code: Code.parse("invalid_type") })],
        rungUsed: "tool",
      }),
    };
  }

  if (valueTransform !== undefined) {
    return enforceTransformedToolOutput(
      calls[0].args,
      withoutSyntheticCall,
      outputSchema,
      valueTransform,
    );
  }

  const parsed = outputSchema.safeParse(calls[0].args);
  if (!parsed.success) {
    return {
      parts: withoutSyntheticCall,
      result: parseEnforcementResult(outputSchema, {
        valid: false,
        issues: enforcementIssuesFromError(parsed.error),
        rungUsed: "tool",
      }),
    };
  }

  const jsonValue = JsonValue.safeParse(parsed.data);
  if (!jsonValue.success) {
    return {
      parts: withoutSyntheticCall,
      result: parseEnforcementResult(outputSchema, {
        valid: false,
        issues: enforcementIssuesFromError(jsonValue.error),
        rungUsed: "tool",
      }),
    };
  }

  return {
    parts: [...withoutSyntheticCall, { type: "text", text: canonicalJson(jsonValue.data) }],
    result: parseEnforcementResult(outputSchema, {
      value: parsed.data,
      valid: true,
      rungUsed: "tool",
    }),
  };
}

async function enforceTransformedToolOutput<Schema extends z.ZodType>(
  args: JsonValue,
  parts: Part[],
  outputSchema: Schema,
  valueTransform: ValueTransform,
): Promise<{ readonly parts: Part[]; readonly result: EnforcementResult<Schema> }> {
  const transformed = await applyValueTransform(valueTransform, outputSchema, args);
  if (!transformed.ok) {
    return {
      parts,
      result: parseEnforcementResult(outputSchema, {
        valid: false,
        issues: transformed.issues,
        rungUsed: "tool",
      }),
    };
  }
  const jsonValue = JsonValue.safeParse(transformed.tokenized);
  if (!jsonValue.success) {
    return {
      parts,
      result: parseEnforcementResult(outputSchema, {
        valid: false,
        issues: enforcementIssuesFromError(jsonValue.error),
        rungUsed: "tool",
      }),
    };
  }
  return {
    parts: [...parts, { type: "text", text: canonicalJson(jsonValue.data) }],
    result: parseTokenizedEnforcementResult<Schema>({
      value: jsonValue.data,
      valid: true,
      rungUsed: "tool",
    }),
  };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}
