// SPDX-License-Identifier: Apache-2.0
import { Code } from "../primitives.js";
import { SecretRefSchema } from "../secret-ref.js";
import { z } from "zod";

/** Configuration for in-process and shared request-rate limiting. */
export const RateLimitsConfigSchema = z
  .object({
    backend: z.enum(["memory", "postgres", "redis"]).default("memory"),
    onUnavailable: z.enum(["local", "deny"]).default("local"),
    redis: z
      .object({
        url: SecretRefSchema,
        keyPrefix: Code.default("harness"),
        tls: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(({ backend, redis }) => (backend === "redis" ? redis !== undefined : redis === undefined), {
    path: ["redis"],
    message: "redis_rate_limit_config_required_only_for_redis_backend",
  })
  .prefault({});

/** Inferred shared rate-limit configuration. */
export type RateLimitsConfig = z.infer<typeof RateLimitsConfigSchema>;
