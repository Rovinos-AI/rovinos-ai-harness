// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  findTokens,
  InMemoryVault,
  isToken,
  normalize,
  Token,
  tokenType,
  VaultValueError,
} from "./index.js";

describe("Token", () => {
  it.each(["<EMAIL_1>", "<A_9>", "<A0_B_123456>"])("accepts %s", (value) => {
    expect(Token.safeParse(value).success).toBe(true);
    expect(isToken(value)).toBe(true);
  });

  it.each(["<email_1>", "<EMAIL_0>", "<1EMAIL_1>", "<EMAIL_1234567>", "EMAIL_1"])(
    "rejects %s",
    (value) => {
      expect(Token.safeParse(value).success).toBe(false);
      expect(isToken(value)).toBe(false);
    },
  );

  it("rejects non-string values", () => {
    expect(isToken(undefined)).toBe(false);
  });

  it("finds tokens in mixed text but not near-misses", () => {
    const text = "mail <EMAIL_1>, bad <email_1>; zero <EMAIL_0>; phone <PHONE_2>.";

    expect(findTokens(text)).toEqual([
      { token: "<EMAIL_1>", index: 5 },
      { token: "<PHONE_2>", index: 53 },
    ]);
  });

  it("returns the token entity type", () => {
    expect(tokenType("<EMAIL_1>")).toBe("EMAIL");
  });

  it("exposes the public vault API", () => {
    expect(new InMemoryVault()).toBeInstanceOf(InMemoryVault);
    expect(normalize("email", " Alice@Example.test ")).toBe("alice@example.test");
    expect(new VaultValueError("vault_value_empty").code).toBe("vault_value_empty");
  });
});
