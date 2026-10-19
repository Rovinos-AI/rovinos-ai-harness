// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "@harness/schemas";

/** Validates an offload handle. */
export const OffloadedHandleSchema = z
  .string()
  .length(29)
  .regex(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u);

/** Inferred offload handle. */
export type OffloadedHandle = z.infer<typeof OffloadedHandleSchema>;

/** Schema for the small result value stored in place of an offloaded result. */
export const OffloadedStub = z
  .object({
    $offloaded: z
      .object({
        handle: OffloadedHandleSchema,
        bytes: z.number().int().nonnegative(),
        preview: z.string(),
      })
      .strict(),
    metadata: JsonValue.optional(),
  })
  .strict();

/** Inferred offloaded result stub. */
export type OffloadedStub = z.infer<typeof OffloadedStub>;

export const ReadOffloadedResultSchema = z
  .object({
    data: z.string(),
    nextOffset: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred result of a paged offload read. */
export type ReadOffloadedResult = z.infer<typeof ReadOffloadedResultSchema>;

/** Input contract for the built-in `read_offloaded` tool. */
export const ReadOffloadedInputSchema = z
  .object({
    handle: OffloadedHandleSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
