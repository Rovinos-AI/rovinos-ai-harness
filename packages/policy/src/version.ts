// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { PolicyDocumentSchema } from "./schema.js";
import type { PolicyDocument } from "./schema.js";

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
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Policy document is not JSON.");
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
