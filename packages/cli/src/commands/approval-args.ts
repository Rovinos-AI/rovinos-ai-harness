// SPDX-License-Identifier: Apache-2.0
import type { JsonValue } from "@harness/schemas";
import type { findTokens } from "@harness/vault";

type FindTokens = typeof findTokens;

/** Replaces token strings in JSON using values resolved for the current approval. */
export function revealApprovalTokens(
  value: JsonValue,
  resolve: (token: string) => string | undefined,
  find: FindTokens,
): JsonValue {
  if (typeof value === "string") {
    let offset = 0;
    let result = "";
    for (const match of find(value)) {
      result += value.slice(offset, match.index) + (resolve(match.token) ?? match.token);
      offset = match.index + match.token.length;
    }
    return result + value.slice(offset);
  }
  if (Array.isArray(value)) {
    return value.map((item) => revealApprovalTokens(item, resolve, find));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revealApprovalTokens(item, resolve, find)]),
    );
  }
  return value;
}

/** Collects unique token strings from JSON approval arguments. */
export function collectApprovalTokens(
  value: JsonValue,
  tokens: Set<string>,
  find: FindTokens,
): void {
  if (typeof value === "string") {
    for (const match of find(value)) {
      tokens.add(match.token);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectApprovalTokens(item, tokens, find);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectApprovalTokens(item, tokens, find);
    }
  }
}
