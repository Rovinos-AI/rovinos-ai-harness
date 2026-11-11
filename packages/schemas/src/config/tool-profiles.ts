// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "../primitives.js";

const ToolProfileSchema = z
  .array(Code)
  .max(1_000)
  .superRefine((toolIds, context) => {
    const seen = new Set<string>();
    for (const [index, toolId] of toolIds.entries()) {
      if (seen.has(toolId)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Tool IDs must be unique within a profile.",
          params: { errorCode: "tool_profile_tool_duplicate" },
        });
      }
      seen.add(toolId);
    }
  });

/** Named subsets of the configured MCP tool catalog. */
export const ToolProfilesConfigSchema = z
  .record(Code, ToolProfileSchema)
  .superRefine((profiles, context) => {
    if (Object.keys(profiles).length > 128) {
      context.addIssue({
        code: "custom",
        message: "Tool profile count exceeds the configured limit.",
        params: { errorCode: "tool_profile_count_exceeded" },
      });
    }
  });

/** Inferred named MCP tool profiles. */
export type ToolProfilesConfig = z.infer<typeof ToolProfilesConfigSchema>;
