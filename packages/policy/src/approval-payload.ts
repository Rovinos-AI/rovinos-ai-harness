// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  compileJsonSchema,
  HarnessError,
  Id,
  JsonPointerSchema,
  JsonValue as JsonValueSchema,
} from "@harness/schemas";
import type { Code as CodeValue, JsonPointer, JsonValue } from "@harness/schemas";
import { z } from "zod";

const APPROVAL_RESOURCE_URI = "ui://harness/approval/v1";

/** Validated payload rendered by approval interfaces and stored in the approval event. */
export const ApprovalPayloadSchema = z
  .object({
    payloadVersion: z.literal(1),
    kind: z.enum(["tool_call", "resume_ambiguity"]),
    callId: Id,
    toolId: Code,
    args: JsonValueSchema,
    ruleId: Code,
    reason: Code,
    summary: z.string().max(500),
    ui: z
      .object({
        resourceUri: z.literal(APPROVAL_RESOURCE_URI),
        fallbackText: z.string(),
      })
      .strict(),
    editableFields: z.array(JsonPointerSchema),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Inferred approval request payload contract. */
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

/** A single JSON Pointer replacement requested by an approver. */
export const ApprovalEditSchema = z
  .object({
    pointer: JsonPointerSchema,
    value: JsonValueSchema,
  })
  .strict();

/** Strict contract for the edits submitted with an approval decision. */
export const ApprovalEditsSchema = z.array(ApprovalEditSchema);

/** Inferred single approval edit contract. */
export type ApprovalEdit = z.infer<typeof ApprovalEditSchema>;

const ApprovalPayloadBuildOptionsSchema = z
  .object({
    kind: z.enum(["tool_call", "resume_ambiguity"]).optional(),
    call: z
      .object({
        callId: Id,
        toolId: Code,
        args: JsonValueSchema,
      })
      .strict(),
    rule: z
      .object({
        ruleId: Code,
        reason: Code,
        editableFields: z.array(JsonPointerSchema),
        approvalTtlMs: z.number().int().positive().optional(),
      })
      .strict(),
    now: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if ((options.kind ?? "tool_call") === "tool_call" && options.rule.approvalTtlMs !== undefined) {
      if (options.now === undefined) {
        context.addIssue({
          code: "custom",
          path: ["now"],
          message: "A clock value is required for expiring approvals.",
        });
      } else if (!Number.isSafeInteger(options.now + options.rule.approvalTtlMs)) {
        context.addIssue({
          code: "custom",
          path: ["now"],
          message: "Approval expiry must be a safe integer.",
        });
      }
    }
  });

/** Inputs used to create a deterministic approval payload. */
export type ApprovalPayloadBuildOptions = z.input<typeof ApprovalPayloadBuildOptionsSchema>;

/**
 * Builds the schema-validated approval payload from tokenized call arguments and a matched rule.
 *
 * @param input - Call, policy rule metadata, optional kind, and injected current time.
 * @returns A payload with the policy's editable fields, expiry, UI resource, and text fallback.
 * @throws {z.ZodError} If the call, rule metadata, or expiry is invalid.
 */
export function buildApprovalPayload(input: ApprovalPayloadBuildOptions): ApprovalPayload {
  const options = ApprovalPayloadBuildOptionsSchema.parse(input);
  const kind = options.kind ?? "tool_call";
  const summary = `Tool ${options.call.toolId} requests approval (rule ${options.rule.ruleId})`;
  const expiresAt =
    kind === "tool_call" && options.rule.approvalTtlMs !== undefined && options.now !== undefined
      ? options.now + options.rule.approvalTtlMs
      : undefined;
  return ApprovalPayloadSchema.parse({
    payloadVersion: 1,
    kind,
    ...options.call,
    ruleId: options.rule.ruleId,
    reason: options.rule.reason,
    summary,
    ui: { resourceUri: APPROVAL_RESOURCE_URI, fallbackText: summary },
    editableFields: kind === "resume_ambiguity" ? [] : options.rule.editableFields,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

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

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(copyJson);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyJson(child)]));
  }
  return value;
}

function pointerSegments(pointer: JsonPointer): string[] {
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isInsideEditableField(pointer: JsonPointer, editableField: JsonPointer): boolean {
  return (
    editableField === "" || pointer === editableField || pointer.startsWith(`${editableField}/`)
  );
}

function setPointer(root: JsonValue, pointer: JsonPointer, value: JsonValue): JsonValue {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return copyJson(value);
  }

  let current = root;
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        throw new ApprovalEditError("edit_invalid");
      }
      const arrayIndex = Number(segment);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= current.length) {
        throw new ApprovalEditError("edit_invalid");
      }
      if (isLast) {
        current[arrayIndex] = copyJson(value);
      } else {
        const child = current[arrayIndex];
        if (child === undefined) {
          throw new ApprovalEditError("edit_invalid");
        }
        current = child;
      }
    } else if (isJsonObject(current)) {
      if (isLast) {
        Object.defineProperty(current, segment, {
          configurable: true,
          enumerable: true,
          value: copyJson(value),
          writable: true,
        });
      } else {
        if (!Object.hasOwn(current, segment)) {
          throw new ApprovalEditError("edit_invalid");
        }
        const child = current[segment];
        if (child === undefined) {
          throw new ApprovalEditError("edit_invalid");
        }
        current = child;
      }
    } else {
      throw new ApprovalEditError("edit_invalid");
    }
  }
  return root;
}

function validateToolInput(args: JsonValue, toolInputSchema: unknown): void {
  try {
    compileJsonSchema(toolInputSchema)(args);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }
}

/**
 * Applies allowed JSON Pointer edits, validates the complete arguments against the MCP JSON
 * Schema, then tokenizes them before returning the value for durable recording or use.
 *
 * @param payload - Validated approval request containing the original tokenized arguments.
 * @param edits - Replacements submitted by an approver.
 * @param toolInputSchema - External tool JSON Schema supplied by the MCP bridge.
 * @param tokenize - Injected PII tokenizer adapter; it is always called with `tool_input`.
 * @returns The edited, validated, tokenized arguments.
 * @throws ApprovalEditError with `edit_not_allowed` or `edit_invalid`; tokenizer errors propagate.
 */
export async function validateEdits(
  payload: ApprovalPayload,
  edits: readonly ApprovalEdit[],
  toolInputSchema: unknown,
  tokenize: ApprovalEditTokenizer,
): Promise<JsonValue> {
  let validatedPayload: ApprovalPayload;
  let validatedEdits: ApprovalEdit[];
  try {
    validatedPayload = ApprovalPayloadSchema.parse(payload);
    validatedEdits = ApprovalEditsSchema.parse(edits);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }

  if (
    validatedEdits.some(
      ({ pointer }) =>
        !validatedPayload.editableFields.some((field) => isInsideEditableField(pointer, field)),
    )
  ) {
    throw new ApprovalEditError("edit_not_allowed");
  }

  let args = copyJson(validatedPayload.args);
  for (const edit of validatedEdits) {
    args = setPointer(args, edit.pointer, edit.value);
  }
  validateToolInput(args, toolInputSchema);
  const tokenized = await tokenize(args, {
    boundary: "tool_input",
    destination: { tool: validatedPayload.toolId },
  });
  try {
    return JsonValueSchema.parse(tokenized);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }
}
