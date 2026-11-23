// SPDX-License-Identifier: Apache-2.0
import type { Tokenizer } from "@rovinos/pii";
import { McpPromptError } from "@rovinos/mcp";
import type { Id } from "@rovinos/schemas";

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Creates the model-input PII boundary for retrieved prompt content. */
export function createMcpPromptTokenizer(tokenizer: Tokenizer) {
  return async (runId: Id, content: string, signal: AbortSignal): Promise<string> => {
    if (isAborted(signal)) {
      throw new McpPromptError("mcp_prompt_failed");
    }
    try {
      const tokenized = await tokenizer.tokenizeText(runId, content, {
        boundary: "model_input",
        destination: "hosted",
      });
      if (isAborted(signal)) {
        throw new McpPromptError("mcp_prompt_failed");
      }
      return tokenized.text;
    } catch (error) {
      if (error instanceof McpPromptError) {
        throw error;
      }
      throw new McpPromptError("mcp_prompt_failed");
    }
  };
}
