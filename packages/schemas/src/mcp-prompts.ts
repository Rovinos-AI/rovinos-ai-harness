// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";

const MAX_PROMPT_SELECTIONS = 16;
const MAX_PROMPT_ARGUMENTS = 32;
const MAX_PROMPT_ARGUMENT_NAME_BYTES = 128;
const MAX_PROMPT_ARGUMENT_VALUE_BYTES = 8_192;
const MAX_PROMPT_ARGUMENTS_BYTES = 32_768;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Exact MCP prompt name configured as an outbound retrieval grant. */
export const McpPromptNameSchema = z.string().min(1);

/** Unique exact prompt names granted on one configured MCP server. */
export const McpPromptGrantsSchema = z.array(McpPromptNameSchema).superRefine((names, context) => {
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(name)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Prompt grants must be unique.",
        params: { errorCode: "server_prompt_grant_duplicate" },
      });
    }
    seen.add(name);
  }
});

const McpPromptArgumentsSchema = z
  .record(z.string().min(1), z.string())
  .superRefine((arguments_, context) => {
    const entries = Object.entries(arguments_);
    if (entries.length > MAX_PROMPT_ARGUMENTS) {
      context.addIssue({
        code: "custom",
        message: "A prompt selection has too many arguments.",
        params: { errorCode: "mcp_prompt_arguments_invalid" },
      });
    }
    for (const [name, value] of entries) {
      if (utf8Bytes(name) > MAX_PROMPT_ARGUMENT_NAME_BYTES) {
        context.addIssue({
          code: "custom",
          message: "A prompt argument name is too large.",
          params: { errorCode: "mcp_prompt_arguments_invalid" },
        });
      }
      if (utf8Bytes(value) > MAX_PROMPT_ARGUMENT_VALUE_BYTES) {
        context.addIssue({
          code: "custom",
          message: "A prompt argument value is too large.",
          params: { errorCode: "mcp_prompt_arguments_invalid" },
        });
      }
    }
    if (utf8Bytes(JSON.stringify(arguments_)) > MAX_PROMPT_ARGUMENTS_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Prompt arguments are too large.",
        params: { errorCode: "mcp_prompt_arguments_invalid" },
      });
    }
  });

/** One operator-selected prompt on a configured server, with bounded string arguments. */
export const McpPromptSelectionSchema = z
  .object({
    serverId: Code,
    name: McpPromptNameSchema,
    arguments: McpPromptArgumentsSchema.optional(),
  })
  .strict();

/** Bounded run-level outbound prompt selections. */
export const McpPromptSelectionsSchema = z
  .array(McpPromptSelectionSchema)
  .max(MAX_PROMPT_SELECTIONS);

/** Inferred operator-selected prompt request. */
export type McpPromptSelection = z.infer<typeof McpPromptSelectionSchema>;
