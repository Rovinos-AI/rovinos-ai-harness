// SPDX-License-Identifier: Apache-2.0
// Browser-safe approval contract shared by policy (17.4) and the approval app (5.3).
import { z } from "zod";
import { Code, Id } from "./primitives.js";
import { JsonValue } from "./json.js";
import { JsonPointerSchema } from "./config/pii.js";

/** Validated payload rendered by approval interfaces and stored in the approval event. */
export const ApprovalPayloadSchema = z
  .object({
    payloadVersion: z.literal(1),
    kind: z.enum(["tool_call", "resume_ambiguity"]),
    callId: Id,
    toolId: Code,
    args: JsonValue,
    ruleId: Code,
    reason: Code,
    summary: z.string().max(500),
    ui: z
      .object({
        resourceUri: z.literal("ui://harness/approval/v1"),
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
