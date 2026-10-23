// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ApprovalPayloadSchema } from "./approval-payload.js";
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
