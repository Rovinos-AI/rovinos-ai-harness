// SPDX-License-Identifier: Apache-2.0
import { TOKEN_TYPE_MAX_LENGTH } from "@harness/schemas";
import type { Code } from "@harness/schemas";
import { z } from "zod";

/** Runtime schema for the stable placeholder token format. */
export const Token = z
  .string()
  .regex(new RegExp(`^<[A-Z][A-Z0-9_]{0,${TOKEN_TYPE_MAX_LENGTH - 1}}_[1-9]\\d{0,5}>$`, "u"));

/** A run-scoped placeholder for a sensitive value. */
export type Token = z.infer<typeof Token>;

/** Return the token prefix for an entity type. */
export function tokenTypeName(entityType: Code): string {
  return entityType.toUpperCase().replaceAll(/[-.]/gu, "_");
}

const TOKEN_PATTERN = new RegExp(
  `^<[A-Z][A-Z0-9_]{0,${TOKEN_TYPE_MAX_LENGTH - 1}}_[1-9]\\d{0,5}>$`,
  "u",
);

/** Check whether an unknown value is a valid token. */
export function isToken(value: unknown): value is Token {
  return Token.safeParse(value).success;
}

/** Find valid tokens in text and return their UTF-16 offsets. */
export function findTokens(text: string): { token: Token; index: number }[] {
  const pattern = new RegExp(
    `<[A-Z][A-Z0-9_]{0,${TOKEN_TYPE_MAX_LENGTH - 1}}_[1-9]\\d{0,5}>`,
    "gu",
  );
  const found: { token: Token; index: number }[] = [];

  for (const match of text.matchAll(pattern)) {
    if (TOKEN_PATTERN.test(match[0])) {
      found.push({ token: match[0], index: match.index });
    }
  }

  return found;
}

/** Return the uppercase entity-type segment of a valid token. */
export function tokenType(token: Token): string {
  return token.slice(1, token.lastIndexOf("_"));
}
