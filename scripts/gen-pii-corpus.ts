// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_SEED = 0x13_11_2026;
const outputPath = fileURLToPath(new URL("../test/pii-corpus/corpus.jsonl", import.meta.url));

/** One synthetic span labeled with its entity type and UTF-16 offsets. */
export const PiiCorpusSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    entityType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  })
  .strict();

/** One synthetic corpus sample with labels validated against its source text. */
export const PiiCorpusSampleSchema = z
  .object({
    id: z.string().regex(/^pii-[a-z0-9-]{1,48}$/u),
    text: z.string().min(1).max(10_000),
    spans: z.array(PiiCorpusSpanSchema).max(32),
  })
  .strict()
  .superRefine((sample, context) => {
    for (const [index, span] of sample.spans.entries()) {
      if (span.end <= span.start || span.end > sample.text.length) {
        context.addIssue({
          code: "custom",
          path: ["spans", index],
          message: "Invalid labeled span.",
        });
      }
    }
  });

/** A validated corpus sample. */
export type PiiCorpusSample = z.infer<typeof PiiCorpusSampleSchema>;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function createSample(
  id: string,
  textPrefix: string,
  value: string,
  entityType: string,
): PiiCorpusSample {
  const text = `${textPrefix}${value}`;
  return PiiCorpusSampleSchema.parse({
    id,
    text,
    spans: [{ start: textPrefix.length, end: textPrefix.length + value.length, entityType }],
  });
}

function createNegative(id: string, text: string): PiiCorpusSample {
  return PiiCorpusSampleSchema.parse({ id, text, spans: [] });
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const otherIndex = Math.floor(random() * (index + 1));
    const value = shuffled[index];
    const other = shuffled[otherIndex];
    if (value === undefined || other === undefined) {
      throw new TypeError("Unable to shuffle corpus.");
    }
    shuffled[index] = other;
    shuffled[otherIndex] = value;
  }
  return shuffled;
}

function contactSamples(): PiiCorpusSample[] {
  return [
    createSample("pii-email-1", "Send the notice to ", "ada@example.test", "email"),
    createSample("pii-email-2", "The synthetic contact is ", "grace.hopper@example.test", "email"),
    createSample("pii-email-3", "Reply to ", "support+demo@example.test", "email"),
    createSample("pii-phone-1", "Call ", "+14155550123", "phone"),
    createSample("pii-phone-2", "The demo number is ", "(415) 555-0132", "phone"),
    createSample("pii-phone-3", "For a test call use ", "415-555-0199", "phone"),
  ];
}

function financialSamples(): PiiCorpusSample[] {
  return [
    createSample(
      "pii-card-1",
      "The synthetic payment number is ",
      "4111111111111111",
      "credit_card",
    ),
    createSample("pii-card-2", "Use the test card ", "4012888888881881", "credit_card"),
    createSample("pii-iban-1", "The demo transfer uses ", "GB82WEST12345698765432", "iban"),
    createSample("pii-iban-2", "The test account is ", "DE89370400440532013000", "iban"),
  ];
}

function networkSamples(): PiiCorpusSample[] {
  const placeholderKey = `ghp_${"0".repeat(36)}`;
  const firstCredentialUrl = [
    "https://",
    "demo-user",
    ":",
    "synthetic-pass",
    "@",
    "localhost",
  ].join("");
  const secondCredentialUrl = [
    "http://",
    "test-user",
    ":",
    "placeholder-pass",
    "@",
    "localhost",
  ].join("");
  return [
    createSample("pii-ip-1", "Connect to ", "192.0.2.10", "ip_address"),
    createSample("pii-ip-2", "The documentation address is ", "2001:db8::1", "ip_address"),
    createSample("pii-key-1", "The fake service key is ", "AKIA0000000000000000", "api_key"),
    createSample("pii-key-2", "The placeholder token is ", placeholderKey, "api_key"),
    createSample("pii-url-1", "The demo URL is ", firstCredentialUrl, "url_credentials"),
    createSample(
      "pii-url-2",
      "Use this synthetic endpoint ",
      secondCredentialUrl,
      "url_credentials",
    ),
  ];
}

function identitySamples(): PiiCorpusSample[] {
  return [
    createSample("pii-person-1", "The assigned reviewer is ", "Alice Example", "person_name"),
    createSample("pii-person-2", "The test operator is ", "Grace Sample", "person_name"),
    createSample("pii-person-3", "The sample profile belongs to ", "Jordan Sample", "person_name"),
    createSample("pii-location-1", "The synthetic location is ", "Paris", "location"),
    createSample("pii-location-2", "The test office is in ", "London", "location"),
    createSample("pii-location-3", "The demo destination is ", "New York", "location"),
  ];
}

function negativeSamples(): PiiCorpusSample[] {
  return [
    createNegative("pii-negative-order", "Order ORD-987654321012 is queued for processing."),
    createNegative("pii-negative-timestamp", "The fixture was created at 2025-06-15T12:34:56Z."),
    createNegative("pii-negative-version", "The test runner reports version v26.12.0."),
    createNegative("pii-negative-luhn", "The invalid test card is 4111111111111112."),
    createNegative("pii-negative-ip", "The invalid documentation address is 999.999.999.999."),
  ];
}

/** Renders deterministic, synthetic positive and negative examples for a fixed seed. */
export function generatePiiCorpus(seed = DEFAULT_SEED): string {
  const samples = [
    ...contactSamples(),
    ...financialSamples(),
    ...networkSamples(),
    ...identitySamples(),
    ...negativeSamples(),
  ];
  return `${shuffle(samples, mulberry32(seed))
    .map((sample) => JSON.stringify(sample))
    .join("\n")}\n`;
}

/** Writes the committed corpus or exits with failure when `--check` detects drift. */
export function runCorpusGenerator(args: readonly string[], target = outputPath): number {
  const check = args.includes("--check");
  if (args.some((argument) => argument !== "--check")) {
    process.stderr.write("Unsupported corpus generator argument.\n");
    return 1;
  }

  const generated = generatePiiCorpus();
  if (check) {
    try {
      if (readFileSync(target, "utf8") !== generated) {
        process.stderr.write("PII corpus differs from its seeded generator.\n");
        return 1;
      }
    } catch {
      process.stderr.write("PII corpus is unavailable for the determinism check.\n");
      return 1;
    }
    return 0;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  return 0;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCorpusGenerator(process.argv.slice(2));
}
