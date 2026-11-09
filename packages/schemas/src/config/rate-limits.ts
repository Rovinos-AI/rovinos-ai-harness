// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Configuration for in-process and shared request-rate limiting. */
export const RateLimitsConfigSchema = z
  .object({
    backend: z.enum(["memory", "postgres", "redis"]).default("memory"),
    onUnavailable: z.enum(["local", "deny"]).default("local"),
  })
  .strict()
  .prefault({});

/** Inferred shared rate-limit configuration. */
export type RateLimitsConfig = z.infer<typeof RateLimitsConfigSchema>;
