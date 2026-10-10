// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Default offload identifier source; callers may inject deterministic IDs. */
export class SystemOffloadIdGenerator {
  /** Returns a fresh ULID for an offload handle. */
  next(): Id {
    const timestamp = BigInt(Math.max(0, Math.floor(Date.now())));
    const random = globalThis.crypto.getRandomValues(new Uint8Array(10));
    let randomValue = 0n;
    for (const byte of random) {
      randomValue = (randomValue << 8n) | BigInt(byte);
    }
    let value = (timestamp << 80n) | randomValue;
    let encoded = "";
    for (let index = 0; index < 26; index += 1) {
      encoded = `${ULID_ALPHABET[Number(value & 31n)] ?? "0"}${encoded}`;
      value >>= 5n;
    }
    return Id.parse(encoded);
  }
}
