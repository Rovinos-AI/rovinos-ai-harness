// SPDX-License-Identifier: Apache-2.0
import { OffloadingToolPort } from "@rovinos/context";
import { PiiToolPort } from "@rovinos/pii";
import type { ModelToolCall, ToolPort } from "./ports.js";
import type { RunState } from "./run-state.js";
import type { ToolResumeContext } from "./resume-policy.js";
import type { RoleRegistry } from "./roles.js";
import { createSubagentTool } from "./subagent/runtime.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { RuntimeComposition } from "./runtime-config.js";
import { AskUserTool } from "./builtin/ask-user-tool.js";
import { VerifyTool } from "./builtin/verify-tool.js";
import { composeToolPorts } from "./runtime-tool-port.js";

type RuntimeToolPortOptions = RuntimeComposition & {
  readonly roles: RoleRegistry;
  readonly scopes: RunScopeRegistry;
};

function createPinForRun(
  options: RuntimeToolPortOptions,
  pinToolForRun: ToolPort["pinForRun"],
): ToolPort["pinForRun"] {
  if (pinToolForRun === undefined) {
    return undefined;
  }
  return async (pinOptions) =>
    createRuntimeToolPort({
      ...options,
      tool: await pinToolForRun(pinOptions),
    });
}

function createResumeStrategy(
  spawnResumeStrategy: ToolPort["resumeStrategy"],
  innerResumeStrategy: ToolPort["resumeStrategy"],
  piiPort: PiiToolPort | undefined,
  offloadingPort: OffloadingToolPort | undefined,
): NonNullable<ToolPort["resumeStrategy"]> {
  return (toolId) => {
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
  };
}

/** Builds the runtime's PII/offload-wrapped subagent tool port. */
export function createRuntimeToolPort(options: RuntimeToolPortOptions): ToolPort {
  const builtins = composeToolPorts(new AskUserTool(), new VerifyTool());
  const toolWithBuiltins = composeToolPorts(builtins, options.tool, {
    preferAdditionalSpecs: true,
  });
  const subagentTool = createSubagentTool({
    config: options.config,
    clock: options.clock,
    ids: options.ids,
    store: options.store,
    model: options.model,
    parentTool: toolWithBuiltins,
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
      : new OffloadingToolPort(piiTool, options.overrides.workspace, {}, {
          ids: options.ids,
          artifactKeyProvider: options.keys,
        });
  const composed = offloadingPort ?? piiTool;
  const spawnResumeStrategy = subagentTool.resumeStrategy?.bind(subagentTool);
  const innerResumeStrategy = toolWithBuiltins.resumeStrategy?.bind(toolWithBuiltins);
  const pinToolForRun = options.tool.pinForRun?.bind(options.tool);
  const getCatalogVersion = options.tool.catalogVersion?.bind(options.tool);
  const getCatalogFingerprints = options.tool.catalogFingerprints?.bind(options.tool);
  const pinForRun = createPinForRun(options, pinToolForRun);
  return Object.assign(composed, {
    ...(pinForRun === undefined ? {} : { pinForRun }),
    ...(getCatalogVersion === undefined ? {} : { catalogVersion: getCatalogVersion }),
    ...(getCatalogFingerprints === undefined
      ? {}
      : { catalogFingerprints: getCatalogFingerprints }),
    resumeStrategy: createResumeStrategy(
      spawnResumeStrategy,
      innerResumeStrategy,
      piiPort,
      offloadingPort,
    ),
  });
}
