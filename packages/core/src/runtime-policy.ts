// SPDX-License-Identifier: Apache-2.0
import { resolve as resolvePath } from "node:path";
import { PolicyEngine, loadPolicy } from "@rovinos/policy";
import type { PolicyPort } from "./ports.js";
import type { RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

/** Loads and compiles the configured policy once, defaulting to deny all tools. */
export async function createRuntimePolicy(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<PolicyPort> {
  const policy =
    overrides.policy ??
    (config.policy?.file === undefined
      ? new PolicyEngine({ version: 1, defaultDecision: "deny", rules: [] })
      : new PolicyEngine(
          await loadPolicy(
            resolvePath(overrides.roleConfigDirectory ?? process.cwd(), config.policy.file),
          ),
        ));
  const globallyRequired = config.policy?.approvals?.separationOfDuties === true;
  if (!globallyRequired) {
    return policy;
  }
  return {
    version: policy.version,
    decide(call, context) {
      const decision = policy.decide(call, context);
      return { ...decision, separationOfDuties: true };
    },
  };
}
