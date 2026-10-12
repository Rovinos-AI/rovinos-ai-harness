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
  .strict()
  .superRefine((payload, context) => {
    if (payload.kind === "resume_ambiguity" && payload.editableFields.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["editableFields"],
        message: "Resume-ambiguity requests cannot have editable fields.",
        params: { errorCode: "approval_payload_resume_editable" },
      });
    }
  });

/** Inferred approval request payload contract. */
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

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
        id: Code,
        reason: Code,
        editable: z.array(JsonPointerSchema).optional(),
        approvalTtlMs: z.number().int().positive().optional(),
      })
      .strict(),
    now: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.rule.approvalTtlMs !== undefined) {
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
  const summary = `Tool ${options.call.toolId} requests approval (rule ${options.rule.id})`;
  const expiresAt =
    options.rule.approvalTtlMs !== undefined && options.now !== undefined
      ? options.now + options.rule.approvalTtlMs
      : undefined;
  return ApprovalPayloadSchema.parse({
    payloadVersion: 1,
    kind,
    ...options.call,
    ruleId: options.rule.id,
    reason: options.rule.reason,
    summary,
    ui: { resourceUri: APPROVAL_RESOURCE_URI, fallbackText: summary },
    editableFields: kind === "resume_ambiguity" ? [] : (options.rule.editable ?? []),
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

/** Validates tokenized arguments against a tool schema using an in-memory token resolver. */
export type ApprovalEditSchemaValidator = (
  args: JsonValue,
  schema: JsonValue,
) => boolean | Promise<boolean>;

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

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index];
        return other !== undefined && jsonValuesEqual(value, other);
      })
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        const value = left[key];
        const other = right[key];
        return (
          Object.hasOwn(right, key) &&
          value !== undefined &&
          other !== undefined &&
          jsonValuesEqual(value, other)
        );
      })
    );
  }
  return false;
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

/** Converts whole-argument edits into deterministic JSON Pointer operations. */
export function diffToEdits(before: JsonValue, after: JsonValue): ApprovalEdit[] {
  return collectChangedEdits(before, after);
}

function collectChangedEdits(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path = "",
): ApprovalEdit[] {
  if (before === undefined) {
    return after === undefined
      ? []
      : [{ pointer: JsonPointerSchema.parse(path), value: after }];
  }
  if (after === undefined) {
    return [{ pointer: JsonPointerSchema.parse(path), remove: true }];
  }
  if (jsonValuesEqual(before, after)) {
    return [];
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).flatMap((key) =>
      collectChangedEdits(
        before[key],
        after[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const commonLength = Math.min(before.length, after.length);
    const replacements = Array.from({ length: commonLength }, (_, index) =>
      collectChangedEdits(before[index], after[index], `${path}/${String(index)}`),
    ).flat();
    const removals = Array.from(
      { length: Math.max(0, before.length - after.length) },
      (_, offset) => ({
        pointer: JsonPointerSchema.parse(`${path}/${String(before.length - offset - 1)}`),
        remove: true as const,
      }),
    );
    const additions = Array.from(
      { length: Math.max(0, after.length - before.length) },
      (_, offset) => ({
        pointer: JsonPointerSchema.parse(`${path}/${String(before.length + offset)}`),
        value: after[before.length + offset] ?? null,
      }),
    );
    return [...replacements, ...removals, ...additions];
  }
  return [{ pointer: JsonPointerSchema.parse(path), value: after }];
}

/** Returns whether every changed leaf falls within a policy-approved pointer. */
export function approvalEditsAreAllowed(
  payload: ApprovalPayload,
  edits: readonly ApprovalEdit[],
): boolean {
  return edits.every((edit) => {
    const existing = valueAtPointer(payload.args, edit.pointer);
    const changed = "remove" in edit ? existing : existing === undefined ? edit.value : undefined;
    const pointers =
      changed === undefined
        ? [edit.pointer]
        : collectLeafPointers(changed, edit.pointer);
    return pointers.every((pointer) =>
      payload.editableFields.some((field) => isInsideEditableField(pointer, field)),
    );
  });
}

function valueAtPointer(root: JsonValue, pointer: JsonPointer): JsonValue | undefined {
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return undefined;
      }
      const child = current[Number(segment)];
      if (child === undefined) {
        return undefined;
      }
      current = child;
    } else if (isJsonObject(current)) {
      const child = current[segment];
      if (child === undefined) {
        return undefined;
      }
      current = child;
    } else {
      return undefined;
    }
  }
  return current;
}

function collectLeafPointers(value: JsonValue, path: JsonPointer): JsonPointer[] {
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [path]
      : entries.flatMap(([key, child]) =>
          collectLeafPointers(
            child,
            JsonPointerSchema.parse(`${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
          ),
        );
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [path]
      : value.flatMap((child, index) =>
          collectLeafPointers(child, JsonPointerSchema.parse(`${path}/${String(index)}`)),
        );
  }
  return [path];
}

function setPointer(
  root: JsonValue,
  pointer: JsonPointer,
  edit: ApprovalEdit,
): JsonValue {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    if ("remove" in edit) {
      throw new ApprovalEditError("edit_invalid");
    }
    return copyJson(edit.value);
  }

  let current = root;
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        throw new ApprovalEditError("edit_invalid");
      }
      const arrayIndex = Number(segment);
      if (
        !Number.isSafeInteger(arrayIndex) ||
        arrayIndex > current.length ||
        (arrayIndex === current.length && "remove" in edit)
      ) {
        throw new ApprovalEditError("edit_invalid");
      }
      if (isLast) {
        if ("remove" in edit) {
          current.splice(arrayIndex, 1);
        } else if (arrayIndex === current.length) {
          current.push(copyJson(edit.value));
        } else {
          current[arrayIndex] = copyJson(edit.value);
        }
      } else {
        const child = current[arrayIndex];
        if (child === undefined) {
          if (arrayIndex !== current.length) {
            throw new ApprovalEditError("edit_invalid");
          }
          const nextSegment = segments[index + 1];
          const created: JsonValue =
            nextSegment !== undefined && /^(?:0|[1-9]\d*)$/u.test(nextSegment) ? [] : {};
          current.push(created);
          current = created;
        } else {
          current = child;
        }
      }
    } else if (isJsonObject(current)) {
      if (isLast) {
        if ("remove" in edit) {
          if (!Object.hasOwn(current, segment)) {
            throw new ApprovalEditError("edit_invalid");
          }
          Reflect.deleteProperty(current, segment);
        } else {
          Object.defineProperty(current, segment, {
            configurable: true,
            enumerable: true,
            value: copyJson(edit.value),
            writable: true,
          });
        }
      } else {
        const child = current[segment];
        if (child === undefined) {
          const nextSegment = segments[index + 1];
          const created: JsonValue =
            nextSegment !== undefined && /^(?:0|[1-9]\d*)$/u.test(nextSegment) ? [] : {};
          Object.defineProperty(current, segment, {
            configurable: true,
            enumerable: true,
            value: created,
            writable: true,
          });
          current = created;
        } else {
          current = child;
        }
      }
    } else {
      throw new ApprovalEditError("edit_invalid");
    }
  }
  return root;
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
 * @param edits - Replacements submitted by an approver.
 * @param toolInputSchema - Optional external tool JSON Schema supplied by the MCP bridge.
 * @param tokenize - Injected PII tokenizer adapter; it is always called with `tool_input`.
 * @param validateSchema - Optional validator that resolves existing tokens only in memory.
 * @returns The edited, validated, tokenized arguments.
 * @throws ApprovalEditError with `edit_not_allowed` or `edit_invalid`; tokenizer errors propagate.
 */
export async function validateEdits(
  payload: ApprovalPayload,
  edits: readonly ApprovalEdit[],
  toolInputSchema: JsonValue | undefined,
  tokenize: ApprovalEditTokenizer,
  validateSchema?: ApprovalEditSchemaValidator,
): Promise<JsonValue> {
  let validatedPayload: ApprovalPayload;
  let validatedEdits: ApprovalEdit[];
  try {
    validatedPayload = ApprovalPayloadSchema.parse(payload);
    validatedEdits = ApprovalEditsSchema.parse(edits);
  } catch {
    throw new ApprovalEditError("edit_invalid");
  }

  if (!approvalEditsAreAllowed(validatedPayload, validatedEdits)) {
    throw new ApprovalEditError("edit_not_allowed");
  }

  let args = copyJson(validatedPayload.args);
  for (const edit of validatedEdits) {
    args = setPointer(args, edit.pointer, edit);
  }
  if (toolInputSchema !== undefined) {
    let isValid: boolean;
    try {
      isValid =
        validateSchema === undefined
          ? validateToolInput(args, toolInputSchema)
          : await validateSchema(args, toolInputSchema);
    } catch {
      isValid = false;
    }
    if (!isValid) {
      throw new ApprovalEditError("edit_invalid");
    }
  }
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
