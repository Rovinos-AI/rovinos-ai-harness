// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const OpenAIErrorMetadataSchema = z.object({
  status: z.number().optional(),
  headers: z.instanceof(Headers).nullish(),
});

const ProviderErrorFrameSchema = z.looseObject({
  type: z.string().optional(),
  code: z.string().optional(),
  error: z.unknown().optional(),
});

/** Returns the provider error type or code from a response frame. */
export function providerErrorType(error: unknown): string | undefined {
  const parsed = ProviderErrorFrameSchema.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const nested = ProviderErrorFrameSchema.safeParse(parsed.data.error);
  return nested.success
    ? (nested.data.type ?? nested.data.code ?? parsed.data.type ?? parsed.data.code)
    : (parsed.data.type ?? parsed.data.code);
}
