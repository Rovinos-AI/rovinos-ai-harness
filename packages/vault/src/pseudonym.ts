// SPDX-License-Identifier: Apache-2.0
import { hkdfSha256, hmacSha256 } from "@harness/crypto";
import { Code, HarnessError, Id, Pseudonym, type KeyProvider } from "@harness/schemas";
import { z } from "zod";
import { normalize } from "./normalize.js";

const PSEUDONYM_KEY_INFO = "harness/pseudonym";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function isKeyProvider(value: unknown): value is KeyProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    "currentKeyId" in value &&
    typeof value.currentKeyId === "function" &&
    "getKey" in value &&
    typeof value.getKey === "function"
  );
}

const PseudonymizeOptionsSchema = z
  .object({
    value: z.string(),
    scope: z.union([z.literal("global"), Id]),
    keyProvider: z.custom<KeyProvider>(isKeyProvider),
    keyId: Code.optional(),
  })
  .strict();

/** Validated inputs for {@link pseudonymize}. */
export type PseudonymizeOptions = z.infer<typeof PseudonymizeOptionsSchema>;

class PseudonymError extends HarnessError {
  readonly code = "pseudonym_input_invalid";

  constructor() {
    super("Pseudonym input is invalid");
  }
}

function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((buffer >> bits) & 31);
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 31);
  }

  return output;
}

/**
 * Creates a scoped, non-reversible pseudonym for an identifier using a secret key.
 *
 * @param options - Identifier, global or run scope, key provider, and optional key version.
 * @returns A lowercase base32 pseudonym safe for a registered telemetry attribute.
 * @throws `pseudonym_input_invalid` for invalid input without echoing the identifier.
 */
export async function pseudonymize(options: PseudonymizeOptions): Promise<Pseudonym> {
  let parsed: ReturnType<typeof PseudonymizeOptionsSchema.safeParse>;
  try {
    parsed = PseudonymizeOptionsSchema.safeParse(options);
  } catch {
    throw new PseudonymError();
  }
  if (!parsed.success) {
    throw new PseudonymError();
  }

  const { value, scope, keyProvider, keyId } = parsed.data;
  const selectedKeyId = keyId ?? keyProvider.currentKeyId();
  if (!Code.safeParse(selectedKeyId).success) {
    throw new PseudonymError();
  }

  const masterKey = await keyProvider.getKey(selectedKeyId);
  const derivedKey = hkdfSha256(masterKey, PSEUDONYM_KEY_INFO);
  const data = Buffer.from(`${scope}\0${normalize("user", value)}`, "utf8");
  try {
    const mac = hmacSha256(derivedKey, data);
    try {
      return Pseudonym.parse(`p_${encodeBase32(mac.subarray(0, 16))}`);
    } finally {
      mac.fill(0);
    }
  } finally {
    derivedKey.fill(0);
    data.fill(0);
  }
}
