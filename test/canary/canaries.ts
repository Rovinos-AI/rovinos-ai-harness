// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, type Code as CodeValue } from "@harness/schemas";

/** A deterministic synthetic value and its encoded forms used by leak-gate tests. */
export interface CanaryValue {
  readonly entityType: CodeValue;
  readonly value: string;
  readonly variants: readonly string[];
}

/** The synthetic PII values generated for one canary run. */
export interface CanarySet {
  readonly email: CanaryValue;
  readonly phone: CanaryValue;
  readonly card: CanaryValue;
  readonly apiKey: CanaryValue;
  readonly person: CanaryValue;
  readonly all: readonly CanaryValue[];
  readonly strings: readonly string[];
}

function digitString(hex: string, length: number): string {
  return Array.from({ length }, (_, index) =>
    (Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) % 10).toString(),
  ).join("");
}

function luhnCheckDigit(prefix: string): string {
  let sum = 0;
  let double = true;
  for (const digit of [...prefix].reverse()) {
    let value = Number(digit);
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    double = !double;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

function canary(entityType: string, value: string): CanaryValue {
  return {
    entityType: Code.parse(entityType),
    value,
    variants: [encodeURIComponent(value), Buffer.from(value, "utf8").toString("base64")],
  };
}

/**
 * Generate stable, run-unique synthetic values without embedding real personal data.
 *
 * @param seed - Unique seed supplied by the calling test run.
 */
export function createCanaries(seed: string): CanarySet {
  const hex = createHash("sha256").update(seed).digest("hex");
  const cardPrefix = `411111${digitString(hex.slice(16), 9)}`;
  const all = [
    canary("email", `c${hex.slice(0, 16)}@example.test`),
    canary("phone", `+1-202-555-${digitString(hex.slice(32), 4)}`),
    canary("credit_card", `${cardPrefix}${luhnCheckDigit(cardPrefix)}`),
    canary("api_key", `hsk_live_${hex.slice(40, 64)}`),
    canary("person_name", `Ada-${hex.slice(56, 64)}`),
  ] as const;

  return {
    email: all[0],
    phone: all[1],
    card: all[2],
    apiKey: all[3],
    person: all[4],
    all,
    strings: [...new Set(all.flatMap(({ value, variants }) => [value, ...variants]))],
  };
}
