// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ApprovalPayloadSchema } from "./approval-payload.js";
import { InputRequestSchema } from "./human-input.js";
import { JsonValue } from "./json.js";
import { JsonPointerSchema } from "./config/pii.js";
import { Code, Id } from "./primitives.js";

const ApprovalEditSchema = z
  .object({
    pointer: JsonPointerSchema,
    value: JsonValue,
  })
  .strict();

/** Input shown to the approval app, keeping the approval id distinct from its tool call id. */
export const ApprovalAppInputSchema = z
  .object({
    approvalId: Id,
    payload: ApprovalPayloadSchema,
  })
  .strict();

/** Inferred input delivered to the approval app. */
export type ApprovalAppInput = z.infer<typeof ApprovalAppInputSchema>;

/** Input to fetch one pending approval payload for the human approval app. */
export const ApprovalAppGetRequestSchema = z
  .object({
    approvalId: Id,
  })
  .strict();

/** Inferred input to fetch an approval payload for the app. */
export type ApprovalAppGetRequest = z.infer<typeof ApprovalAppGetRequestSchema>;

/** Input displayed by the human input app, optionally enriched with run metadata. */
export const InputAppInputSchema = InputRequestSchema.extend({
  runId: Id.optional(),
  ageMs: z.number().int().nonnegative().optional(),
}).strict();

/** Inferred input delivered to the human input app. */
export type InputAppInput = z.infer<typeof InputAppInputSchema>;

/** Input to fetch one pending request for the human input app. */
export const InputAppGetRequestSchema = z.object({ requestId: Id }).strict();

/** Inferred input to fetch one pending request for the app. */
export type InputAppGetRequest = z.infer<typeof InputAppGetRequestSchema>;

/** Metadata-only pending input item displayed when the app is opened from a list. */
export const InputAppPendingSummarySchema = z
  .object({
    requestId: Id,
    runId: Id,
    source: z.enum(["mcp_mrtr", "mcp_legacy", "agent"]),
    mode: z.enum(["form", "url"]),
    serverId: Code.optional(),
    round: z.number().int().nonnegative(),
    ageMs: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Pending input list returned by `list_pending_inputs`. */
export const InputAppListSchema = z
  .object({ inputs: z.array(InputAppPendingSummarySchema) })
  .strict();

/** Input answer submitted by the human input app. */
export const InputAnswerRequestSchema = z
  .object({
    requestId: Id,
    action: z.enum(["accept", "decline", "cancel"]),
    answer: JsonValue.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.action !== "accept" && request.answer !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "Declined and cancelled input requests cannot include an answer.",
        params: { errorCode: "input_response_invalid" },
      });
    }
  });

/** Inferred app input answer request. */
export type InputAnswerRequest = z.infer<typeof InputAnswerRequestSchema>;

/** Result returned after an app input answer is submitted. */
export const InputAnswerResponseSchema = z
  .object({
    resolved: z.boolean(),
    code: Code.optional(),
  })
  .strict();

/** Inferred result from an app input answer. */
export type InputAnswerResponse = z.infer<typeof InputAnswerResponseSchema>;

/** Input to the host-local approval resolve tool. */
export const ResolveRequest = z
  .object({
    approvalId: Id,
    decision: z.enum(["approve", "deny", "edit"]),
    edits: z.array(ApprovalEditSchema).optional(),
  })
  .strict();

/** Inferred input to the host-local approval resolve tool. */
export type ResolveRequest = z.infer<typeof ResolveRequest>;

/** Result returned by the host-local approval resolve tool. */
export const ResolveResponse = z
  .object({
    ok: z.boolean(),
    code: Code.optional(),
  })
  .strict();

/** Inferred result from the host-local approval resolve tool. */
export type ResolveResponse = z.infer<typeof ResolveResponse>;

/** Input to the host-local audited approval reveal tool. */
export const RevealRequest = z
  .object({
    approvalId: Id,
    pointers: z.array(JsonPointerSchema).max(20),
  })
  .strict();

/** Inferred input to the host-local approval reveal tool. */
export type RevealRequest = z.infer<typeof RevealRequest>;

/** One raw value returned by the host-local audited approval reveal tool. */
const RevealedValueSchema = z
  .object({
    pointer: JsonPointerSchema,
    value: z.string(),
  })
  .strict();

/** Result returned by the host-local audited approval reveal tool. */
export const RevealResponse = z
  .object({
    values: z.array(RevealedValueSchema),
  })
  .strict();

/** Inferred result from the host-local audited approval reveal tool. */
export type RevealResponse = z.infer<typeof RevealResponse>;
