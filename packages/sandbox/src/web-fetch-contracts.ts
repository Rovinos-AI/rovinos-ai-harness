// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Fixed response body cap for runner-initiated web fetches. */
export const MAX_WEB_FETCH_BYTES = 2 * 1024 * 1024;
/** Fixed total deadline, including redirects and response-body reads. */
export const MAX_WEB_FETCH_TIMEOUT_MS = 20_000;
export const MAX_WEB_FETCH_REDIRECTS = 5;

const acceptedTypes = ["text/html", "text/plain", "text/markdown", "application/json"] as const;

/** Validated input shared by the built-in tool, runner endpoint, and remote client. */
export const WebFetchRequestSchema = z
  .object({
    url: z
      .url()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.username === "" &&
            url.password === ""
          );
        } catch {
          return false;
        }
      }),
    accept: z.enum(acceptedTypes).optional(),
    stripQuery: z.boolean().optional(),
  })
  .strict();

/** Inferred fetch input. */
export type WebFetchRequest = z.infer<typeof WebFetchRequestSchema>;

const WebFetchResponseBaseSchema = z
  .object({
    url: z.url(),
    status: z.number().int().min(100).max(599),
    contentType: z.string().min(1).max(255),
    truncated: z.boolean(),
    untrusted: z.literal(true),
  })
  .strict();

/** Validated, untrusted text or binary response returned by the runner. */
export const WebFetchResultSchema = z.union([
  WebFetchResponseBaseSchema.extend({
    binary: z.literal(true),
    bytes: z.array(z.number().int().min(0).max(255)).max(MAX_WEB_FETCH_BYTES),
  }).strict(),
  WebFetchResponseBaseSchema.extend({
    text: z.string(),
    hiddenTextDropped: z.number().int().nonnegative(),
  }).strict(),
]);

/** Inferred fetch result. */
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;
