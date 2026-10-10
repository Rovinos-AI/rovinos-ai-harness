// SPDX-License-Identifier: Apache-2.0
import type { ContextPort, ToolPort } from "../ports.js";
import {
  modelStep,
  modelToolOptions,
  type ModelStepOptions,
  type ModelStepResult,
} from "./model-step.js";

/** Runs one model step and applies any token-usage observation to the context port. */
export async function requestModel(
  options: ModelStepOptions & { readonly tool: ToolPort },
  context: ContextPort,
): Promise<ModelStepResult> {
  const estimatedTokens = context.estimate?.(options.messages);
  const result = await modelStep({
    ...options,
    ...modelToolOptions(options.tool, options.messages),
  });
  if (result.outcome === "response" && estimatedTokens !== undefined) {
    context.observeModelResponse?.(
      {
        provider: result.completion.provider,
        model: result.completion.model,
      },
      estimatedTokens,
      result.completion.usage.inputTokens,
    );
  }
  return result;
}
