// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Sha256Hex, type ModelRequest } from "@rovinos/schemas";
import { canonicalJson } from "@rovinos/schemas/request-signature";

export { canonicalJson } from "@rovinos/schemas/request-signature";

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
