// SPDX-License-Identifier: Apache-2.0
// Control-plane settings are owned by tasks 18.4 and 18.5.
import { Code, Id } from "../primitives.js";
import { SecretRefSchema } from "../secret-ref.js";
import { z } from "zod";

/** Authentication scopes accepted by the control-plane server. */
export const ControlPlaneAuthScopeSchema = z.enum([
  "read",
  "read_content",
  "approve",
  "run",
  "reveal",
  "admin",
]);

const authTokenSchema = z
  .object({
    id: Code.max(58),
    secret: SecretRefSchema,
    scopes: z.array(ControlPlaneAuthScopeSchema).min(1),
    runIds: z.array(Id).min(1).optional(),
  })
  .strict();

/** Configuration for control-plane authentication, network binding, and approval views. */
export const ControlPlaneConfigSchema = z
  .object({
    allowReveal: z.boolean().default(false),
    auth: z
      .object({ tokens: z.array(authTokenSchema).default([]) })
      .strict()
      .default({ tokens: [] })
      .superRefine(({ tokens }, context) => {
        const ids = new Set<string>();
        tokens.forEach((token, index) => {
          if (ids.has(token.id)) {
            context.addIssue({
              code: "custom",
              path: ["tokens", index, "id"],
              message: "Token IDs must be unique.",
            });
          }
          ids.add(token.id);
        });
      }),
    listen: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(0).max(65_535).default(3_000),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 3_000 }),
    tls: z
      .object({
        certFile: SecretRefSchema,
        keyFile: SecretRefSchema,
      })
      .strict()
      .optional(),
    allowedHosts: z.array(z.string().min(1)).min(1).default(["127.0.0.1", "localhost", "::1"]),
    rateLimitPerMinute: z.number().int().positive().default(120),
  })
  .strict()
  .default({
    allowReveal: false,
    auth: { tokens: [] },
    listen: { host: "127.0.0.1", port: 3_000 },
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    rateLimitPerMinute: 120,
  });

/** Inferred control-plane configuration. */
export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;
/** Inferred control-plane authentication scope. */
export type ControlPlaneAuthScope = z.infer<typeof ControlPlaneAuthScopeSchema>;
