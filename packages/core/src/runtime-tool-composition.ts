// SPDX-License-Identifier: Apache-2.0
import { OffloadingToolPort } from "@rovinos/context";
import type { Code } from "@rovinos/schemas";
import { PiiToolPort } from "@rovinos/pii";
import type { ModelToolCall, ToolPort } from "./ports.js";
import type { RunState } from "./run-state.js";
import type { ToolResumeContext } from "./resume-policy.js";
import type { RoleRegistry } from "./roles.js";
import { createSubagentTool } from "./subagent/runtime.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { RuntimeComposition } from "./runtime-config.js";
import { AskUserTool } from "./builtin/ask-user-tool.js";
import { composeToolPorts } from "./runtime-tool-port.js";

/** Builds the runtime's PII/offload-wrapped subagent tool port. */
export function createRuntimeToolPort(
  options: RuntimeComposition & {
    readonly roles: RoleRegistry;
    readonly scopes: RunScopeRegistry;
  },
): ToolPort {
  const toolWithAskUser = composeToolPorts(new AskUserTool(), options.tool);
  const subagentTool = createSubagentTool({
    config: options.config,
    clock: options.clock,
    ids: options.ids,
    store: options.store,
    model: options.model,
    parentTool: toolWithAskUser,
    policy: options.policy,
    policyVersion: options.policyVersion,
    sandboxBackend: options.sandboxBackend,
    workspaceSnapshotter: options.workspaceSnapshotter,
    roles: options.roles,
    scopes: options.scopes,
    ...(options.pii === undefined ? {} : { resolver: options.pii.resolver }),
  });
  const piiPort =
    options.pii === undefined || options.overrides.alreadyTokenized === true
      ? undefined
      : new PiiToolPort(subagentTool, {
          tokenizer: options.pii.tokenizer,
          config: options.pii.config,
          resolver: options.pii.resolver,
        });
  const piiTool = piiPort ?? subagentTool;
  const offloadingPort =
    options.overrides.workspace === undefined
      ? undefined
      : new OffloadingToolPort(piiTool, options.overrides.workspace, {}, options.ids);
  const composed = offloadingPort ?? piiTool;
  const spawnResumeStrategy = subagentTool.resumeStrategy?.bind(subagentTool);
  const innerResumeStrategy = toolWithAskUser.resumeStrategy?.bind(toolWithAskUser);
  return Object.assign(composed, {
    resumeStrategy: (toolId: Code) => {
      const strategy = spawnResumeStrategy?.(toolId) ?? innerResumeStrategy?.(toolId);
      if (strategy === undefined) {
        return undefined;
      }
      return {
        onDanglingIntent: async (
          call: ModelToolCall,
          state: RunState,
          context: ToolResumeContext,
        ) => {
          const decision = await strategy.onDanglingIntent(call, state, context);
          if (decision.kind !== "result") {
            return decision;
          }
          let execution = decision.execution;
          if (piiPort !== undefined) {
            execution = await piiPort.sanitizeRecoveredResult(call, context, execution);
          }
          if (offloadingPort !== undefined) {
            execution = await offloadingPort.offloadRecoveredResult(call, context, execution);
          }
          return { ...decision, execution };
        },
      };
    },
  });
}
