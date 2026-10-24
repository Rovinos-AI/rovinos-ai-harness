// SPDX-License-Identifier: Apache-2.0
// cspell:ignore cgremmlbygheaazvmfz foob fooba hlxaaxgj hunjzpwizhbyeotelaisi
// cspell:ignore mhumxy mzxq mzxw ytboi aiusxzm
import { describe, expect, it, vi } from "vitest";
import type * as Crypto from "@rovinos/crypto";
import { encodeBase32, pseudonymize, type PseudonymizeOptions } from "./pseudonym.js";

const cryptoMocks = vi.hoisted(() => {
  const capture: {
    derivedKey: Uint8Array;
    mac: Uint8Array;
    message: Uint8Array;
  } = {
    derivedKey: new Uint8Array(),
    mac: new Uint8Array(),
    message: new Uint8Array(),
  };
  return {
    hkdf: vi.fn<
      (masterKey: Uint8Array, info: string | Uint8Array, length?: number) => Uint8Array
    >(),
    hmac: vi.fn<(key: Uint8Array, data: Uint8Array) => Uint8Array>(),
    capture,
  };
});

vi.mock("@rovinos/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  cryptoMocks.hkdf.mockImplementation((...args) => {
    const derivedKey = actual.hkdfSha256(...args);
    cryptoMocks.capture.derivedKey = derivedKey;
    return derivedKey;
  });
  cryptoMocks.hmac.mockImplementation((key, message) => {
    const mac = actual.hmacSha256(key, message);
    cryptoMocks.capture.message = message;
    cryptoMocks.capture.mac = mac;
    return mac;
  });
  return { ...actual, hkdfSha256: cryptoMocks.hkdf, hmacSha256: cryptoMocks.hmac };
});

const runA = "00000000000000000000000000";
const runB = "00000000000000000000000001";
const keyA = new Uint8Array(32).fill(7);
const keyB = new Uint8Array(32).fill(8);

function keyProvider() {
  return {
    currentKeyId: () => "current",
    getKey: (keyId: string) => {
      if (keyId === "current") {
        return Promise.resolve(keyA);
      }
      if (keyId === "previous") {
        return Promise.resolve(keyB);
      }
      return Promise.reject(new Error("synthetic key not found"));
    },
  };
}

describe("encodeBase32", () => {
  it.each([
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ])("encodes RFC 4648 input %j as lowercase base32 with padding omitted", (input, expected) => {
    expect(encodeBase32(Buffer.from(input))).toBe(expected);
  });
});

describe("pseudonymize", () => {
  it("matches independent global and run-scoped HKDF/HMAC known-answer vectors", async () => {
    const provider = keyProvider();

    await expect(
      pseudonymize({ value: "alice@example.test", scope: "global", keyProvider: provider }),
    ).resolves.toBe("p_mhumxy5hlxaaxgj56f4aiusxzm");
    await expect(
      pseudonymize({ value: "alice@example.test", scope: runA, keyProvider: provider }),
    ).resolves.toBe("p_cgremmlbygheaazvmfz2rwt4sa");
  });

  it("normalizes by trimming and NFKC without case folding", async () => {
    const provider = keyProvider();
    const normalized = await pseudonymize({
      value: "  Ａlice@example.test\u00a0",
      scope: "global",
      keyProvider: provider,
    });

    expect(normalized).toBe("p_m6zb6hunjzpwizhbyeotelaisi");
    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
      }),
    ).resolves.not.toBe(normalized);
  });

  it("returns a deterministic pseudonym with the required format", async () => {
    const options = {
      value: "alice@example.test",
      scope: "global" as const,
      keyProvider: keyProvider(),
    };

    const first = await pseudonymize(options);
    const second = await pseudonymize(options);

    expect(first).toMatch(/^p_[a-z2-7]{26}$/u);
    expect(second).toBe(first);
  });

  it("uses normalized values, explicit keys, and scope in the MAC", async () => {
    const provider = keyProvider();
    const baseline = await pseudonymize({
      value: " alice@example.test ",
      scope: "global",
      keyProvider: provider,
    });

    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
      }),
    ).resolves.toBe(baseline);
    await expect(
      pseudonymize({
        value: "bob@example.test",
        scope: "global",
        keyProvider: provider,
      }),
    ).resolves.not.toBe(baseline);
    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: runA,
        keyProvider: provider,
      }),
    ).resolves.not.toBe(baseline);
    await expect(
      pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
        keyId: "previous",
      }),
    ).resolves.not.toBe(baseline);
  });

  it("makes run-scoped pseudonyms unlinkable across run identifiers", async () => {
    const provider = keyProvider();
    const first = await pseudonymize({
      value: "alice@example.test",
      scope: runA,
      keyProvider: provider,
    });
    const second = await pseudonymize({
      value: "alice@example.test",
      scope: runB,
      keyProvider: provider,
    });

    expect(second).not.toBe(first);
  });

  it("does not return or expose the input value", async () => {
    const value = "alice@example.test";
    const token = "<EMAIL_1>";
    const result = await pseudonymize({ value, scope: "global", keyProvider: keyProvider() });

    expect(result).not.toContain(value);
    expect(result).not.toContain(token);
  });

  it.each(["", " \t\n", "\u00a0", "\u3000"])(
    "rejects an empty value after normalization without echoing it",
    async (value) => {
      const error = await pseudonymize({
        value,
        scope: "global",
        keyProvider: keyProvider(),
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "pseudonym_input_invalid" });
      expect(String(error)).toBe("PseudonymError: Pseudonym input is invalid");
    },
  );

  it("rejects malformed key ids, non-providers, and extra options with a closed error", async () => {
    const provider = keyProvider();
    const malformedKeyId: PseudonymizeOptions = {
      value: "alice@example.test",
      scope: "global",
      keyProvider: provider,
      keyId: "BAD ID",
    };
    const nonProvider = keyProvider();
    Object.defineProperty(nonProvider, "getKey", { value: null });
    const malformedProvider: PseudonymizeOptions = {
      value: "alice@example.test",
      scope: "global",
      keyProvider: nonProvider,
    };
    const extraOption: PseudonymizeOptions = {
      value: "alice@example.test",
      scope: "global",
      keyProvider: provider,
    };
    Object.defineProperty(extraOption, "unexpected", { value: true, enumerable: true });

    await expect(pseudonymize(malformedKeyId)).rejects.toMatchObject({
      code: "pseudonym_input_invalid",
    });
    await expect(pseudonymize(malformedProvider)).rejects.toMatchObject({
      code: "pseudonym_input_invalid",
    });
    await expect(pseudonymize(extraOption)).rejects.toMatchObject({
      code: "pseudonym_input_invalid",
    });
  });

  it.each([0, 31, 33])(
    "rejects provider keys of %i bytes without changing them",
    async (length) => {
      const invalidKey = new Uint8Array(length).fill(9);
      const originalKey = Uint8Array.from(invalidKey);
      const provider = {
        currentKeyId: () => "current",
        getKey: () => Promise.resolve(invalidKey),
      };
      const error = await pseudonymize({
        value: "alice@example.test",
        scope: "global",
        keyProvider: provider,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "pseudonym_key_invalid" });
      expect(String(error)).not.toContain("alice@example.test");
      expect(invalidKey).toEqual(originalKey);
    },
  );

  it("rejects a provider result that is not a Uint8Array", async () => {
    const provider = keyProvider();
    Object.defineProperty(provider, "getKey", {
      value: () => Promise.resolve("not a key"),
    });
    const error = await pseudonymize({
      value: "alice@example.test",
      scope: "global",
      keyProvider: provider,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "pseudonym_key_invalid" });
    expect(String(error)).not.toContain("alice@example.test");
  });

  it("wraps provider rejections in a redacted closed error", async () => {
    const canary = "synthetic-private-input";
    const provider = {
      currentKeyId: () => "current",
      getKey: () => Promise.reject(new Error(canary)),
    };
    const error = await pseudonymize({
      value: canary,
      scope: "global",
      keyProvider: provider,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "pseudonym_key_unavailable" });
    expect(String(error)).not.toContain(canary);
  });

  it("zeroes derived, MAC, and message buffers without modifying the provider key", async () => {
    cryptoMocks.hkdf.mockClear();
    cryptoMocks.hmac.mockClear();
    cryptoMocks.capture.derivedKey = new Uint8Array();
    cryptoMocks.capture.mac = new Uint8Array();
    cryptoMocks.capture.message = new Uint8Array();

    const result = await pseudonymize({
      value: "alice@example.test",
      scope: "global",
      keyProvider: keyProvider(),
    });

    expect(result).toMatch(/^p_[a-z2-7]{26}$/u);
    expect(cryptoMocks.capture.derivedKey.byteLength).toBe(32);
    expect(cryptoMocks.capture.derivedKey.every((byte) => byte === 0)).toBe(true);
    expect(cryptoMocks.capture.mac.byteLength).toBe(32);
    expect(cryptoMocks.capture.mac.every((byte) => byte === 0)).toBe(true);
    expect(cryptoMocks.capture.message.every((byte) => byte === 0)).toBe(true);
    expect(keyA).toEqual(new Uint8Array(32).fill(7));
  });
});
