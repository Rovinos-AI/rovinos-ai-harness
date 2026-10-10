// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, type Capabilities, type Part } from "@harness/schemas";
import { z } from "zod";

/** Structured-output enforcement rung supported by this gateway. */
export const EnforcementRungSchema = z.enum(["native", "tool"]);

/** Inferred structured-output enforcement rung. */
export type EnforcementRung = z.infer<typeof EnforcementRungSchema>;

/** A value-free Zod validation issue. */
export const EnforcementIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: Code,
  })
  .strict();

/** Inferred structured-output validation issue. */
export type EnforcementIssue = z.infer<typeof EnforcementIssueSchema>;

/** Result of validating a structured model output. */
export type EnforcementResult<Value> =
  | { readonly value: Value; readonly valid: true; readonly rungUsed: EnforcementRung }
  | {
      readonly issues: readonly EnforcementIssue[];
      readonly valid: false;
      readonly rungUsed?: EnforcementRung;
    };

/** Raised when structured output is requested alongside real model tools. */
export class OutputWithToolsUnsupportedError extends HarnessError {
  /** Stable rejection code for unsupported output/tool combinations. */
  readonly code = "output_with_tools_unsupported";

  /** Creates the stable output/tool combination error. */
  constructor() {
    super("Structured output cannot be combined with tools.");
  }
}

/** Selects the highest supported enforcement rung permitted by the cap. */
export function selectEnforcementRung(
  capabilities: Capabilities,
  maxRung?: EnforcementRung,
): EnforcementRung | undefined {
  if (capabilities.structuredOutput === "native") {
    return "native";
  }
  if (capabilities.forcedToolChoice && maxRung !== "native") {
    return "tool";
  }
  return undefined;
}

/** Strips tool-call parts with the synthetic structured-output tool id. */
export function stripSyntheticToolCall(parts: readonly Part[]): Part[] {
  return parts.filter((part) => part.type !== "tool_call" || part.toolId !== "emit_result");
}
