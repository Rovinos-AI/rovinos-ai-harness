// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { parseYaml } from "@harness/schemas";
import { PolicyDocumentSchema } from "./schema.js";
import type { PolicyDocument } from "./schema.js";

export {
  compilePolicy,
  evaluate,
  ExplanationSchema,
  PolicyCallSchema,
  type CompiledPolicy,
  type Explanation,
  type PolicyCall,
} from "./evaluate.js";
export { PolicyEngine } from "./engine.js";
export { policyVersion } from "./version.js";
export {
  ApprovalEditError,
  ApprovalEditSchema,
  ApprovalEditsSchema,
  ApprovalPayloadSchema,
  buildApprovalPayload,
  validateEdits,
  type ApprovalEdit,
  type ApprovalEditTokenizer,
  type ApprovalPayload,
  type ApprovalPayloadBuildOptions,
} from "./approval-payload.js";
export {
  ArgMatcherSchema,
  PolicyDocumentSchema,
  RuleSchema,
  type ArgMatcher,
  type JsonPointer,
  type PolicyDocument,
  type Rule,
} from "./schema.js";

/**
 * Loads and validates a YAML or JSON policy document from disk.
 *
 * @param path - Path to the policy file.
 * @returns The validated policy document.
 */
export async function loadPolicy(path: string): Promise<PolicyDocument> {
  return parseYaml(PolicyDocumentSchema, await readFile(path, "utf8"));
}
