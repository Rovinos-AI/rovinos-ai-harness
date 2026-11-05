// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  Id,
  JsonValue,
  ModelRequestSchema,
  ModelResponseSchema,
} from "@rovinos/schemas";
import { createEnforcementResultSchema } from "@rovinos/models";
import { z } from "zod";

/** Closed, content-free failures exposed by the live evaluation boundary. */
export const LiveModelErrorCodeSchema = z.enum([
  "eval_live_config_invalid",
  "eval_live_provider_unsupported",
  "eval_live_egress_denied",
  "eval_live_redirect_denied",
  "eval_live_call_limit_exceeded",
  "eval_live_cancelled",
  "eval_live_request_invalid",
  "eval_live_response_invalid",
  "eval_live_provider_failed",
  "eval_live_transport_failed",
]);

/** Safe live-model failure code. */
export type LiveModelErrorCode = z.infer<typeof LiveModelErrorCodeSchema>;

/** Contains only a closed code; never retains provider errors or their causes. */
export class LiveModelError extends HarnessError {
  readonly code: LiveModelErrorCode;

  /** @param code - Closed failure code, without request or credential data. */
  constructor(code: LiveModelErrorCode) {
    super(code);
    this.code = code;
  }
}

export const LiveModelRequestSchema = z
  .object({
    request: ModelRequestSchema,
    runId: Id,
    deadlineTs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const LiveModelCompletionSchema = ModelResponseSchema.extend({
  providerBlobs: JsonValue,
  enforcement: createEnforcementResultSchema(JsonValue).optional(),
}).strict();

export const LiveModelReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), completion: LiveModelCompletionSchema }).strict(),
  z.object({ ok: z.literal(false), code: LiveModelErrorCodeSchema }).strict(),
]);

/** Maximum UTF-8 bytes accepted in either direction of the socket protocol. */
export const LIVE_MODEL_MAX_BYTES = 1_048_576;

/** Projects unknown failures to a closed code without retaining their content. */
export function liveModelFailure(error: unknown): LiveModelErrorCode {
  return error instanceof LiveModelError ? error.code : "eval_live_provider_failed";
}
