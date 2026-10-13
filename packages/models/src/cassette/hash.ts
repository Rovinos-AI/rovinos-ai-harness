// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Sha256Hex, type ModelRequest } from "@harness/schemas";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hashes the canonical JSON request while excluding its volatile request identifier.
 *
 * @param request - JSON-serializable model request.
 * @returns Lowercase SHA-256 digest.
 */
export function requestHash(request: ModelRequest): Sha256Hex {
  const { requestId: _requestId, ...stableRequest } = request;
  return Sha256Hex.parse(createHash("sha256").update(canonicalJson(stableRequest)).digest("hex"));
}
