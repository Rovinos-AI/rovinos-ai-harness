// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import { compilePolicy, type PolicyCall } from "./evaluate.js";
import type { PolicyDocument } from "./schema.js";
import { policyVersion } from "./version.js";

/**
 * Compiled policy evaluator with a stable document version for run metadata.
 *
 * The class satisfies the core `PolicyPort` structurally; the policy package
 * intentionally does not depend on core.
 */
export class PolicyEngine {
  readonly version: ReturnType<typeof Code.parse>;
  private readonly compiled: ReturnType<typeof compilePolicy>;

  /**
   * Creates an evaluator and compiles the validated policy document once.
   *
   * @param document - Policy document loaded at runtime startup.
   */
  constructor(document: PolicyDocument) {
    this.compiled = compilePolicy(document);
    this.version = Code.parse(policyVersion(document));
  }

  /**
   * Decides whether a prepared tool call may execute.
   *
   * @param call - Tool id and tokenized arguments.
   * @param context - Subagent and optional server context.
   * @returns The decision and its explanation.
   */
  decide(
    call: Omit<PolicyCall, "context">,
    context: PolicyCall["context"],
  ): ReturnType<ReturnType<typeof compilePolicy>["evaluate"]> {
    return this.compiled.evaluate({ ...call, context });
  }
}
