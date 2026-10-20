// SPDX-License-Identifier: Apache-2.0
import { FormSchema, type ServerConfig } from "@harness/schemas";
import { z } from "zod";

const InputRequestParamsSchema = z
  .object({
    mode: z.enum(["form", "url"]),
    message: z.string().max(2_000),
    requestedSchema: FormSchema.optional(),
    url: z.string().max(2_048).optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (
      (params.mode === "form" &&
        (params.requestedSchema === undefined || params.url !== undefined)) ||
      (params.mode === "url" && (params.url === undefined || params.requestedSchema !== undefined))
    ) {
      context.addIssue({ code: "custom", message: "Input request mode does not match its fields." });
    }
    if (params.url !== undefined && !URL.canParse(params.url)) {
      context.addIssue({ code: "custom", path: ["url"], message: "Input URL is invalid." });
    }
  });

const InputRequestEntrySchema = z
  .object({
    method: z.string(),
    params: z.unknown(),
  })
  .strict();

const InputRequiredResultSchema = z
  .object({
    resultType: z.literal("input_required"),
    inputRequests: z.record(z.string(), z.unknown()).optional(),
    requestState: z.string().optional(),
  })
  .passthrough();

/** A validated MRTR elicitation request with its server-assigned correlation key. */
export const ValidatedInputRequestSchema = z
  .object({
    inputKey: z.string().min(1).max(128),
    mode: z.enum(["form", "url"]),
    message: z.string().max(2_000),
    requestedSchema: FormSchema.optional(),
    url: z.string().max(2_048).optional(),
  })
  .strict();

/** Inferred validated MRTR request. */
export type ValidatedInputRequest = z.infer<typeof ValidatedInputRequestSchema>;

/** Schema used to re-validate a tokenized MRTR request before recording it. */
export const ValidatedInputRequestsSchema = z.array(ValidatedInputRequestSchema);

/** Schema for request content sent through tokenization, excluding correlation keys. */
export const InputRequestContentSchema = z.array(
  ValidatedInputRequestSchema.omit({ inputKey: true }),
);

/** Validates every embedded request and enforces per-server MRTR limits. */
export function validateInputRequiredResult(
  value: unknown,
  server: ServerConfig,
): { readonly inputRequests: readonly ValidatedInputRequest[]; readonly requestState?: string } {
  const result = InputRequiredResultSchema.parse(value);
  const entries = Object.entries(result.inputRequests ?? {});
  if (entries.length === 0) {
    throw new Error("mcp_input_request_invalid");
  }
  const inputRequests: ValidatedInputRequest[] = [];
  for (const [inputKey, rawRequest] of entries) {
    const entry = InputRequestEntrySchema.parse(rawRequest);
    if (
      entry.method !== "elicitation/create" ||
      inputKey.length === 0 ||
      inputKey.length > 128 ||
      !server.elicitation.enabled
    ) {
      throw new Error("mcp_input_request_invalid");
    }
    const params = InputRequestParamsSchema.parse(entry.params);
    if (!server.elicitation.modes.includes(params.mode)) {
      throw new Error("mcp_input_request_invalid");
    }
    if (
      params.mode === "form" &&
      params.requestedSchema !== undefined &&
      Object.values(params.requestedSchema.properties).some(
        (property) => property.type === "string" && property.pattern !== undefined,
      )
    ) {
      throw new Error("mcp_input_request_invalid");
    }
    inputRequests.push({
      inputKey,
      mode: params.mode,
      message: params.message,
      ...(params.requestedSchema === undefined ? {} : { requestedSchema: params.requestedSchema }),
      ...(params.url === undefined ? {} : { url: params.url }),
    });
  }
  if (
    result.requestState !== undefined &&
    Buffer.byteLength(result.requestState, "utf8") > server.elicitation.maxRequestStateBytes
  ) {
    throw new Error("mcp_input_request_invalid");
  }
  return {
    inputRequests,
    ...(result.requestState === undefined ? {} : { requestState: result.requestState }),
  };
}
