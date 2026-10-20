// SPDX-License-Identifier: Apache-2.0
// Global elicitation configuration is owned by task 25.1.
import { z } from "zod";

/** Global channels and URL requirements for human input requests. */
export const ElicitationConfigSchema = z
  .object({
    channels: z.array(z.enum(["control_plane", "cli", "app"])).default([]),
    urlAllowHosts: z.array(z.string().min(1)).optional(),
    requireHttps: z.boolean().default(true),
    expiresAfterMs: z.number().int().positive().default(604_800_000),
  })
  .strict()
  .prefault({});

/** Inferred global elicitation configuration. */
export type ElicitationConfig = z.infer<typeof ElicitationConfigSchema>;

/** Per-server elicitation opt-in and resource limits. */
export const ServerElicitationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    modes: z.array(z.enum(["form", "url"])).default(["form"]),
    maxRounds: z.number().int().positive().default(5),
    maxPerRun: z.number().int().positive().default(20),
    maxRequestStateBytes: z.number().int().positive().default(65_536),
    legacyLiveTimeoutMs: z.number().int().positive().default(300_000),
  })
  .strict()
  .prefault({});

/** Inferred per-server elicitation configuration. */
export type ServerElicitationConfig = z.infer<typeof ServerElicitationConfigSchema>;
