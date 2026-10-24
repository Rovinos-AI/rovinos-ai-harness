// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { Id, Sha256Hex } from "@rovinos/schemas";
import type { IdGenerator } from "./ports.js";
import type { Clock } from "./recorder.js";
import type { RuntimeConfig } from "./runtime-config.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** System clock used by runtimes unless a deterministic clock is supplied. */
export const systemClock: Clock = {
  /** Reads the current wall-clock time in milliseconds. */
  now: () => Date.now(),
};

/** Computes a stable digest of the validated runtime configuration. */
export function configHash(config: RuntimeConfig): ReturnType<typeof Sha256Hex.parse> {
  return Sha256Hex.parse(createHash("sha256").update(JSON.stringify(config)).digest("hex"));
}

/** ULID generator using the runtime clock and cryptographic randomness. */
export class SystemIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock) {}

  next(): Id {
    const timestamp = BigInt(Math.max(0, Math.floor(this.clock.now())));
    const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
    let value = (timestamp << 80n) | random;
    let encoded = "";
    for (let index = 0; index < 26; index += 1) {
      encoded = `${ULID_ALPHABET[Number(value & 31n)] ?? "0"}${encoded}`;
      value >>= 5n;
    }
    return Id.parse(encoded);
  }
}
