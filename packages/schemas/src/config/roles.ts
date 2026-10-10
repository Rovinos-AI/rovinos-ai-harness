// SPDX-License-Identifier: Apache-2.0
// Role configuration is owned by core task 23.1.
import { z } from "zod";
import { Code } from "../primitives.js";

/** Optional resource limits imposed on work performed under a role. */
export const RoleBudgetsSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
  })
  .strict();

/** Inferred per-role budget limits. */
export type RoleBudgets = z.infer<typeof RoleBudgetsSchema>;

/** Tool identifier or glob pattern used to select registered tools. */
export const RoleToolPatternSchema = z.union([
  Code,
  z
    .string()
    .max(64)
    .regex(/^[a-z0-9_.-]*(?:\*[a-z0-9_.-]*)+$/u),
]);

/** Inferred tool identifier or pattern. */
export type RoleToolPattern = z.infer<typeof RoleToolPatternSchema>;

/** Prompt text or a config-directory-relative prompt file. */
export const RoleSystemPromptSchema = z.union([
  z.string().max(8_000),
  z.object({ file: z.string().min(1) }).strict(),
]);

/** A model role and its authority, budgets, and context behavior. */
export const RoleConfigSchema = z
  .object({
    id: Code,
    route: Code.optional(),
    systemPrompt: RoleSystemPromptSchema.optional(),
    tools: z.union([z.array(RoleToolPatternSchema), z.literal("*")]),
    budgets: RoleBudgetsSchema.optional(),
    contextStrategy: Code.optional(),
    resultSchema: z.string().min(1).optional(),
    maxDepth: z.number().int().nonnegative().default(2),
    maxChildren: z.number().int().nonnegative().default(8),
  })
  .strict();

/** The configured role set. */
export const RolesConfigSchema = z.array(RoleConfigSchema).default([]);

/** Inferred role configuration after applying role-level defaults. */
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
/** Inferred configured role set. */
export type RolesConfig = z.infer<typeof RolesConfigSchema>;
