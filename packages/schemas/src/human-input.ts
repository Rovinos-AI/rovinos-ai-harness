// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Code, Id } from "./primitives.js";
import { FormSchema } from "./form-schema.js";

export { FormSchema, formSchemaToZod } from "./form-schema.js";

const InputRequestBase = z
  .object({
    requestId: Id,
    source: z.enum(["mcp_mrtr", "mcp_legacy", "agent"]),
    serverId: Code.optional(),
    callId: Id.optional(),
    inputKey: z.string().min(1).max(128).optional(),
    round: z.number().int().nonnegative(),
    mode: z.enum(["form", "url"]),
    message: z.string().max(2_000),
    schema: FormSchema.optional(),
    url: z.url().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Apply shared payload constraints to normalized requests and input-request events. */
export function refineInputRequestPayload(
  request: {
    source: "mcp_mrtr" | "mcp_legacy" | "agent";
    mode: "form" | "url";
    schema?:
      { properties: Record<string, { type: string; pattern?: string | undefined }> } | undefined;
    url?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (request.mode === "form") {
    if (request.schema === undefined && request.source !== "agent") {
      context.addIssue({
        code: "custom",
        path: ["schema"],
        message: "MCP form-mode requests require a form schema.",
        params: { errorCode: "input_request_payload_invalid" },
      });
    }
    if (request.url !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Form-mode requests cannot include a URL.",
        params: { errorCode: "input_request_payload_invalid" },
      });
    }
  } else {
    if (request.url === undefined) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "URL-mode requests require a URL.",
        params: { errorCode: "input_request_payload_invalid" },
      });
    }
    if (request.schema !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["schema"],
        message: "URL-mode requests cannot include a form schema.",
        params: { errorCode: "input_request_payload_invalid" },
      });
    }
  }
  if (
    request.source !== "mcp_legacy" &&
    request.schema !== undefined &&
    Object.values(request.schema.properties).some(
      (field) => field.type === "string" && field.pattern !== undefined,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["schema"],
      message: "Regular-expression patterns are supported only for legacy servers.",
      params: { errorCode: "input_schema_unsupported" },
    });
  }
}

/** Normalized request for information from a human. */
export const InputRequestSchema = InputRequestBase.superRefine(refineInputRequestPayload);

/** Inferred normalized input request. */
export type InputRequest = z.infer<typeof InputRequestSchema>;

/** Normalized human response; URL-mode acceptance may have no answer. */
export const InputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    answer: JsonValue.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.action !== "accept" && response.answer !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "Declined and cancelled input requests cannot include an answer.",
        params: { errorCode: "input_response_invalid" },
      });
    }
  });

/** Inferred normalized response to an input request. */
export type InputResponse = z.infer<typeof InputResponseSchema>;
