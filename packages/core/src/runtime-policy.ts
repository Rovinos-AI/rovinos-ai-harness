// SPDX-License-Identifier: Apache-2.0
import { resolve as resolvePath } from "node:path";
import { PolicyEngine, loadPolicy } from "@harness/policy";
import type { PolicyPort } from "./ports.js";
import type { RuntimeConfig, RuntimeOverrides } from "./runtime-config.js";

/** Loads and compiles the configured policy once, defaulting to deny all tools. */
export async function createRuntimePolicy(
  config: RuntimeConfig,
  overrides: RuntimeOverrides,
): Promise<PolicyPort> {
  if (overrides.policy !== undefined) {
    return overrides.policy;
  }
  if (config.policy?.file === undefined) {
    return new PolicyEngine({ version: 1, defaultDecision: "deny", rules: [] });
  }
  const document = await loadPolicy(
    resolvePath(overrides.roleConfigDirectory ?? process.cwd(), config.policy.file),
  );
  return new PolicyEngine(document);
}
