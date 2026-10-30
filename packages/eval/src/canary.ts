// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code } from "@rovinos/schemas";
import { z } from "zod";

const PERSON_NAMES = ["Ada", "Grace", "Katherine", "Margaret"] as const;
const CanarySeedSchema = z.string().min(1);

/** Schema for a synthetic value and its encoded forms. */
export const CanaryValueSchema = z
  .object({
    entityType: Code,
    value: z.string().min(1),
    variants: z.array(z.string()).readonly(),
  })
  .strict();

/** A deterministic synthetic value and its encoded forms used for leak checks. */
export type CanaryValue = z.infer<typeof CanaryValueSchema>;

/** Schema for synthetic values generated for one canary run. */
export const CanarySetSchema = z
  .object({
    email: CanaryValueSchema,
    phone: CanaryValueSchema,
    card: CanaryValueSchema,
    apiKey: CanaryValueSchema,
    person: CanaryValueSchema,
    all: z.array(CanaryValueSchema).readonly(),
    strings: z.array(z.string()).readonly(),
  })
  .strict();

/** Synthetic values generated for one canary run. */
export type CanarySet = z.infer<typeof CanarySetSchema>;

/** Schema for a labeled content sink that does not retain canary values in results. */
export const CanarySinkSchema = z
  .object({
    name: z.string().min(1),
    content: z.union([z.string(), z.instanceof(Uint8Array)]),
  })
  .strict();

/** A labeled content sink to scan without retaining canary values in results. */
export type CanarySink = z.infer<typeof CanarySinkSchema>;

const CanaryScanOptionsSchema = z
  .object({
    canaries: z.array(z.string().min(1)),
    sinks: z.array(CanarySinkSchema),
  })
  .strict();

function digitString(hex: string, length: number): string {
  return Array.from({ length }, (_, index) =>
    (Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) % 10).toString(),
  ).join("");
}

function luhnCheckDigit(prefix: string): string {
  let sum = 0;
  let double = true;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    let value = Number(prefix.charAt(index));
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
  const first = value.slice(0, 1);
  const percentEncoded =
    `%${first.charCodeAt(0).toString(16).padStart(2, "0")}` + encodeURIComponent(value.slice(1));
  return {
    entityType: Code.parse(entityType),
    value,
    variants: [percentEncoded, Buffer.from(value, "utf8").toString("base64")],
  };
}

/**
 * Generate stable, synthetic values from a trial seed.
 *
 * @param seed - Unique seed supplied by the calling eval or canary run.
 */
export function createCanaries(seed: string): CanarySet {
  const parsedSeed = CanarySeedSchema.parse(seed);
  const hex = createHash("sha256").update(parsedSeed).digest("hex");
  const cardPrefix = `411111${digitString(hex.slice(16), 9)}`;
  const personIndex = Number.parseInt(hex.slice(0, 2), 16) % PERSON_NAMES.length;
  const personName = PERSON_NAMES[personIndex] ?? PERSON_NAMES[0];
  const all = [
    canary("email", `c${hex.slice(0, 16)}@example.test`),
    canary("phone", `+1-202-555-${digitString(hex.slice(32), 4)}`),
    canary("credit_card", `${cardPrefix}${luhnCheckDigit(cardPrefix)}`),
    canary("api_key", `hsk_live_${hex.slice(40, 64)}`),
    canary("person_name", `${personName}-${hex.slice(56, 64)}`),
  ] as const;

  return CanarySetSchema.parse({
    email: all[0],
    phone: all[1],
    card: all[2],
    apiKey: all[3],
    person: all[4],
    all,
    strings: [...new Set(all.flatMap(({ value, variants }) => [value, ...variants]))],
  });
}

/**
 * Scan labeled sinks for exact or encoded canary values.
 *
 * @param canaries - Plaintext and encoded values to detect.
 * @param sinks - Byte or text content labeled by its artifact sink.
 * @returns Unique sink names containing a canary, in input order.
 */
export function scanForCanaries(
  canaries: readonly string[],
  sinks: readonly CanarySink[],
): string[] {
  const parsed = CanaryScanOptionsSchema.parse({ canaries, sinks });
  const matches = new Set<string>();
  for (const sink of parsed.sinks) {
    const content =
      typeof sink.content === "string"
        ? sink.content
        : Buffer.from(sink.content).toString("latin1");
    if (parsed.canaries.some((value) => content.includes(value))) {
      matches.add(sink.name);
    }
  }
  return [...matches];
}
