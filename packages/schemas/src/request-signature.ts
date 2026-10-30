// SPDX-License-Identifier: Apache-2.0
// #640: hash messages separately so storage can re-sign their tokenized form without raw parameters.
import { createHash } from "node:crypto";
import type { Message, ModelRequest } from "./messages.js";
import { Sha256Hex } from "./primitives.js";

/** Serializes JSON-compatible values with object keys in ordinal order. */
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

function hash(value: unknown): Sha256Hex {
  return Sha256Hex.parse(
    createHash("sha256")
      .update(canonicalJson(value) ?? "null")
      .digest("hex"),
  );
}

/** Hashes every request parameter except messages and the volatile request identifier. */
export function modelRequestParametersHash(request: ModelRequest): Sha256Hex {
  return hash(
    Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== "requestId" && key !== "messages"),
    ),
  );
}

/** Combines stored messages with the content-free digest of all other request parameters. */
export function storedModelRequestHash(
  messages: readonly Message[],
  requestParametersHash: Sha256Hex,
): Sha256Hex {
  return hash({ messages, requestParametersHash });
}
