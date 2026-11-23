// SPDX-License-Identifier: Apache-2.0
import { Code, McpPromptSelectionsSchema, Principal } from "@rovinos/schemas";
import { z } from "zod";

const runMetadataSchema = z.record(Code, z.union([Code, z.number(), z.boolean()])).optional();
const goalSchema = z.string().min(1).max(8_000);

/** Input for starting a run. */
export const StartRunOptionsSchema = z
  .object({
    goal: goalSchema,
    metadata: runMetadataSchema,
    role: Code.optional(),
    /** Named MCP tool subset configured by the operator. */
    toolProfile: Code.optional(),
    /** Exact granted MCP prompts to retrieve as untrusted run input. */
    promptSelections: McpPromptSelectionsSchema.optional(),
    idempotencyKey: z.string().min(1).max(256).optional(),
    requestedBy: Principal.optional(),
  })
  .strict();

/** Inferred input for {@link Harness.startRun}. */
export type StartRunOptions = z.infer<typeof StartRunOptionsSchema>;
