// SPDX-License-Identifier: Apache-2.0
import {
  ApprovalPayloadSchema,
  Code,
  Id,
  JsonPointerSchema,
  JsonValue as JsonValueSchema,
  type ApprovalPayload,
} from "@rovinos/schemas";
import { z } from "zod";

const APPROVAL_RESOURCE_URI = "ui://harness/approval/v1";

export { ApprovalPayloadSchema, type ApprovalPayload } from "@rovinos/schemas";

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
    if (options.rule.approvalTtlMs === undefined) {
      return;
    }
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
