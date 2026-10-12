// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseYaml } from "@harness/schemas";
import { PolicyDocumentSchema } from "./schema.js";
import type { PolicyDocument } from "./schema.js";

export {
  ArgMatcherSchema,
  PolicyDocumentSchema,
  RuleSchema,
  type ArgMatcher,
  type JsonPointer,
  type PolicyDocument,
  type Rule,
} from "./schema.js";

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : Number(left > right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Policy document is not JSON.");
}

/**
 * Loads and validates a YAML or JSON policy document from disk.
 *
 * @param path - Path to the policy file.
 * @returns The validated policy document.
 */
export async function loadPolicy(path: string): Promise<PolicyDocument> {
  return parseYaml(PolicyDocumentSchema, await readFile(path, "utf8"));
}

/**
 * Computes a stable, content-addressed version for a policy document.
 *
 * @param document - A policy document to validate and version.
 * @returns The `pol-` prefix followed by 12 lowercase SHA-256 hex characters.
 */
export function policyVersion(document: PolicyDocument): string {
  const validated = PolicyDocumentSchema.parse(document);
  const digest = createHash("sha256").update(canonicalJson(validated)).digest("hex");
  return `pol-${digest.slice(0, 12)}`;
}
