// SPDX-License-Identifier: Apache-2.0
import { hkdfSha256, hmacSha256 } from "@rovinos/crypto";
import {
  Code,
  HarnessError,
  Id,
  KEY_PROVIDER_KEY_BYTES,
  Pseudonym,
  type KeyProvider,
} from "@rovinos/schemas";
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

function isValidMasterKey(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array && value.byteLength === KEY_PROVIDER_KEY_BYTES;
  } catch {
    return false;
  }
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

type PseudonymErrorCode =
  "pseudonym_input_invalid" | "pseudonym_key_invalid" | "pseudonym_key_unavailable";

const pseudonymErrorMessages: Record<PseudonymErrorCode, string> = {
  pseudonym_input_invalid: "Pseudonym input is invalid",
  pseudonym_key_invalid: "Pseudonym key is invalid",
  pseudonym_key_unavailable: "Pseudonym key is unavailable",
};

class PseudonymError extends HarnessError {
  readonly code: PseudonymErrorCode;

  constructor(code: PseudonymErrorCode) {
    super(pseudonymErrorMessages[code]);
    this.code = code;
  }
}

/** Encode bytes as lowercase RFC 4648 base32 without padding. */
export function encodeBase32(bytes: Uint8Array): string {
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
 * @throws `pseudonym_input_invalid`, `pseudonym_key_invalid`, or
 * `pseudonym_key_unavailable` without echoing the identifier or provider error.
 */
export async function pseudonymize(options: PseudonymizeOptions): Promise<Pseudonym> {
  let parsed: ReturnType<typeof PseudonymizeOptionsSchema.safeParse>;
  try {
    parsed = PseudonymizeOptionsSchema.safeParse(options);
  } catch {
    throw new PseudonymError("pseudonym_input_invalid");
  }
  if (!parsed.success) {
    throw new PseudonymError("pseudonym_input_invalid");
  }

  const { value, scope, keyProvider, keyId } = parsed.data;
  const normalizedValue = normalize("user", value).trim();
  if (normalizedValue.length === 0) {
    throw new PseudonymError("pseudonym_input_invalid");
  }

  let selectedKeyId: string;
  try {
    selectedKeyId = keyId ?? keyProvider.currentKeyId();
  } catch {
    throw new PseudonymError("pseudonym_key_unavailable");
  }
  if (!Code.safeParse(selectedKeyId).success) {
    throw new PseudonymError("pseudonym_input_invalid");
  }

  let masterKey: unknown;
  try {
    masterKey = await keyProvider.getKey(selectedKeyId);
  } catch {
    throw new PseudonymError("pseudonym_key_unavailable");
  }
  if (!isValidMasterKey(masterKey)) {
    throw new PseudonymError("pseudonym_key_invalid");
  }

  const derivedKey = hkdfSha256(masterKey, PSEUDONYM_KEY_INFO);
  let data: Buffer | undefined;
  let mac: Uint8Array | undefined;
  try {
    data = Buffer.from(`${scope}\0${normalizedValue}`, "utf8");
    mac = hmacSha256(derivedKey, data);
    return Pseudonym.parse(`p_${encodeBase32(mac.subarray(0, 16))}`);
  } finally {
    mac?.fill(0);
    derivedKey.fill(0);
    data?.fill(0);
  }
}
