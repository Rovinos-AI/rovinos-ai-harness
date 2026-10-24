// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Sha256Hex, type ModelRequest } from "@rovinos/schemas";

/**
 * Serialize JSON-compatible values with object keys in ordinal order.
 * @param value JSON-compatible value.
 * @returns Canonical JSON text, or undefined for an undefined root.
 */
export function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry) ?? "null").join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => {
        if (left < right) {
          return -1;
        }
        if (left > right) {
          return 1;
        }
        return 0;
      });
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry) ?? "null"}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hashes the canonical JSON request while excluding its volatile request identifier.
 *
 * @param request - JSON-serializable model request.
 * @returns Lowercase SHA-256 digest.
 */
export function requestHash(request: ModelRequest): Sha256Hex {
  const stableRequest = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== "requestId"),
  );
  const canonical = canonicalJson(stableRequest);
  return Sha256Hex.parse(
    createHash("sha256")
      .update(canonical ?? "null")
      .digest("hex"),
  );
}
