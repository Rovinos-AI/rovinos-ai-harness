// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";

/** Normalize a value for identity comparisons, without changing the stored value. */
export function normalize(entityType: Code, raw: string): string {
  const normalized = raw.trim().normalize("NFKC");

  if (entityType === "email") {
    return normalized.toLowerCase();
  }

  if (entityType === "phone") {
    return normalized.replaceAll(/[ \-()]/gu, "");
  }

  return normalized;
}
