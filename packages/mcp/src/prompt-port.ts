// SPDX-License-Identifier: Apache-2.0
import { McpPromptSelectionsSchema } from "@rovinos/schemas";
import type { McpPromptSelection, ServerConfig } from "@rovinos/schemas";
import { McpPromptError, McpConnectionError } from "./errors.js";
import { decodedBytes } from "./discovery-budget.js";
import type { McpPool } from "./pool.js";
import type { GetPromptResult, McpPrompt } from "./prompts.js";

const MAX_PROMPT_RESULT_BYTES = 1_048_576;
const MAX_PROMPT_CONTENT_BYTES = 4_194_304;

/** Tokenization-ready content and provenance from one granted MCP prompt. */
export interface McpRetrievedPrompt {
  readonly serverId: ServerConfig["id"];
  readonly name: string;
  readonly content: string;
}

function validatePromptArguments(
  prompt: McpPrompt,
  arguments_: Readonly<Record<string, string>> | undefined,
): void {
  const declared = new Map<string, NonNullable<McpPrompt["arguments"]>[number]>();
  for (const argument of prompt.arguments ?? []) {
    if (argument.name.length === 0 || declared.has(argument.name)) {
      throw new McpPromptError("mcp_prompt_failed");
    }
    declared.set(argument.name, argument);
  }
  const supplied = arguments_ ?? {};
  if (Object.keys(supplied).some((name) => !declared.has(name))) {
    throw new McpPromptError("mcp_prompt_arguments_invalid");
  }
  if (
    [...declared.values()].some(
      (argument) => argument.required === true && !Object.hasOwn(supplied, argument.name),
    )
  ) {
    throw new McpPromptError("mcp_prompt_arguments_invalid");
  }
}

function serializedPrompt(result: GetPromptResult): string {
  const serialized = JSON.stringify({
    ...(result.description === undefined ? {} : { description: result.description }),
    messages: result.messages,
  });
  if (typeof serialized !== "string") {
    throw new McpPromptError("mcp_prompt_failed");
  }
  return serialized;
}

/** Retrieves selected prompts after grant checks, validating arguments and content budgets. */
export async function retrieveGrantedPrompts(
  pool: McpPool,
  servers: readonly ServerConfig[],
  selections: readonly McpPromptSelection[],
  signal: AbortSignal,
): Promise<McpRetrievedPrompt[]> {
  let parsedSelections: McpPromptSelection[];
  try {
    parsedSelections = McpPromptSelectionsSchema.parse(selections);
  } catch {
    throw new McpPromptError("mcp_prompt_arguments_invalid");
  }

  const serversById = new Map(servers.map((server) => [server.id, server] as const));
  for (const selection of parsedSelections) {
    const server = serversById.get(selection.serverId);
    if (server?.promptGrants?.includes(selection.name) !== true) {
      throw new McpPromptError("mcp_prompt_not_granted");
    }
  }

  const promptsByServer = new Map<ServerConfig["id"], McpPrompt[]>();
  const retrieved: McpRetrievedPrompt[] = [];
  let totalContentBytes = 0;
  for (const selection of parsedSelections) {
    let prompts = promptsByServer.get(selection.serverId);
    if (prompts === undefined) {
      prompts = await pool.listPrompts(selection.serverId, signal);
      promptsByServer.set(selection.serverId, prompts);
    }
    const prompt = prompts.find(({ name }) => name === selection.name);
    if (prompt === undefined) {
      throw new McpPromptError("mcp_prompt_unavailable");
    }
    validatePromptArguments(prompt, selection.arguments);
    const result = await pool.getPrompt(
      selection.serverId,
      selection.name,
      selection.arguments,
      signal,
    );
    try {
      decodedBytes(result, MAX_PROMPT_RESULT_BYTES, "mcp_response_too_large", signal);
      totalContentBytes += decodedBytes(
        {
          ...(result.description === undefined ? {} : { description: result.description }),
          messages: result.messages,
        },
        MAX_PROMPT_CONTENT_BYTES - totalContentBytes,
        "mcp_response_too_large",
        signal,
      );
    } catch (error) {
      if (error instanceof McpConnectionError && error.code === "mcp_response_too_large") {
        throw new McpPromptError("mcp_prompt_result_too_large");
      }
      throw new McpPromptError("mcp_prompt_failed");
    }
    retrieved.push({
      serverId: selection.serverId,
      name: selection.name,
      content: serializedPrompt(result),
    });
  }
  return retrieved;
}
