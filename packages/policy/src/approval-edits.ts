// SPDX-License-Identifier: Apache-2.0
import {
  compileJsonSchema,
  HarnessError,
  JsonPointerSchema,
  JsonValue as JsonValueSchema,
} from "@harness/schemas";
import type { Code as CodeValue, JsonValue } from "@harness/schemas";
import { z } from "zod";
import { applyApprovalEdits, approvalEditsAreAllowed } from "./approval-edit-pointers.js";
import { ApprovalPayloadSchema } from "./approval-payload.js";
import type { ApprovalPayload } from "./approval-payload.js";

/** A single JSON Pointer replacement or removal requested by an approver. */
export const ApprovalEditSchema = z.union([
  z
    .object({
      pointer: JsonPointerSchema,
      value: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      pointer: JsonPointerSchema,
      remove: z.literal(true),
    })
    .strict(),
]);

/** Strict contract for the edits submitted with an approval decision. */
export const ApprovalEditsSchema = z.array(ApprovalEditSchema);

/** Inferred single approval edit contract. */
export type ApprovalEdit = z.infer<typeof ApprovalEditSchema>;

/** Error returned when an approval edit is disallowed or invalid. */
export class ApprovalEditError extends HarnessError {
  readonly code: "edit_not_allowed" | "edit_invalid";

  /** Creates a value-free approval edit error. */
  constructor(code: "edit_not_allowed" | "edit_invalid") {
    super(
      code === "edit_not_allowed" ? "Approval edit is not allowed." : "Approval edit is invalid.",
    );
    this.code = code;
    this.name = "ApprovalEditError";
  }
}

/** Tokenizes edited arguments at the `tool_input` boundary for the target tool. */
export type ApprovalEditTokenizer = (
  args: JsonValue,
  context: {
    readonly boundary: "tool_input";
    readonly destination: { readonly tool: CodeValue };
  },
) => Promise<JsonValue>;

/** Validates tokenized arguments against a tool schema using an in-memory token resolver. */
export type ApprovalEditSchemaValidator = (
  args: JsonValue,
  schema: JsonValue,
) => boolean | Promise<boolean>;

/** Adapters that apply the PII tokenizer and optionally resolve tokens for schema validation. */
export interface ApprovalEditAdapters {
  readonly tokenize: ApprovalEditTokenizer;
  readonly validateSchema?: ApprovalEditSchemaValidator;
}

function validateToolInput(args: JsonValue, toolInputSchema: JsonValue): boolean {
  try {
    compileJsonSchema(toolInputSchema)(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies allowed JSON Pointer edits, validates the complete arguments against the optional MCP
 * JSON Schema, then tokenizes them before returning the value for durable recording or use. If no
 * schema is supplied, schema validation is explicitly skipped.
 *
 * @param payload - Validated approval request containing the original tokenized arguments.
 * @param edits - Pointer replacements and removals submitted by an approver.
 * @param toolInputSchema - Optional external tool JSON Schema supplied by the MCP bridge.
 * @param adapters - PII tokenizer and optional token-aware schema validator.
 * @returns The edited, validated, tokenized arguments.
 * @throws ApprovalEditError with `edit_not_allowed` or `edit_invalid`; tokenizer errors propagate.
 */
export async function validateEdits(
  payload: ApprovalPayload,
  edits: readonly ApprovalEdit[],
  toolInputSchema: JsonValue | undefined,
  adapters: ApprovalEditAdapters,
): Promise<JsonValue> {
  let validatedPayload: ApprovalPayload;
  let validatedEdits: ApprovalEdit[];
  try {
    validatedPayload = ApprovalPayloadSchema.parse(payload);
    validatedEdits = ApprovalEditsSchema.parse(edits);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }

  if (validatedPayload.kind === "resume_ambiguity") {
    throw new ApprovalEditError("edit_not_allowed");
  }
  if (!approvalEditsAreAllowed(validatedPayload, validatedEdits)) {
    throw new ApprovalEditError("edit_not_allowed");
  }
  const result = applyApprovalEdits(validatedPayload.args, validatedEdits);
  if (!result.success) {
    throw new ApprovalEditError("edit_invalid");
  }
  if (toolInputSchema !== undefined) {
    let isValid: boolean;
    try {
      isValid =
        adapters.validateSchema === undefined
          ? validateToolInput(result.args, toolInputSchema)
          : await adapters.validateSchema(result.args, toolInputSchema);
    } catch {
      isValid = false;
    }
    if (!isValid) {
      throw new ApprovalEditError("edit_invalid");
    }
  }
  const tokenized = await adapters.tokenize(result.args, {
    boundary: "tool_input",
    destination: { tool: validatedPayload.toolId },
  });
  try {
    return JsonValueSchema.parse(tokenized);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }
}

export { applyApprovalEdits, approvalEditsAreAllowed, diffToEdits } from "./approval-edit-pointers.js";
