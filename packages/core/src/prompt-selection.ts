// SPDX-License-Identifier: Apache-2.0
import { McpPromptSelectionsSchema, type McpPromptSelection } from "@rovinos/schemas";
import { McpPromptError } from "@rovinos/mcp";
import type { RunLoopOptions } from "./loop.js";

/** Retrieves and tokenizes selected MCP prompts before run input is recorded. */
export async function addMcpPromptsToGoal(options: RunLoopOptions): Promise<RunLoopOptions> {
  if (options.promptSelections === undefined || options.promptSelections.length === 0) {
    return options;
  }
  let selections: McpPromptSelection[];
  try {
    selections = McpPromptSelectionsSchema.parse(options.promptSelections);
  } catch {
    throw new McpPromptError("mcp_prompt_arguments_invalid");
  }
  if (options.promptPort === undefined) {
    throw new McpPromptError("mcp_prompt_not_granted");
  }
  const { runId, tokenizeMcpPromptContent: tokenize } = options;
  if (runId === undefined || tokenize === undefined) {
    throw new McpPromptError("mcp_prompt_failed");
  }
  const retrieved = await options.promptPort.retrievePrompts(selections, options.signal);
  const tokenized = await Promise.all(
    retrieved.map(async ({ serverId, name, content }) => ({
      serverId,
      name,
      content: await tokenize(runId, content, options.signal),
    })),
  );
  return {
    ...options,
    goal: {
      initialInput: options.goal,
      retrievedPrompts: tokenized,
    },
  };
}
