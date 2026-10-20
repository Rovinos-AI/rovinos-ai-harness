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

function createCredentialUrlSample(
  id: string,
  textPrefix: string,
  value: string,
  emailAddress: string,
): PiiCorpusSample {
  const emailStart = value.indexOf(emailAddress);
  if (emailStart === -1) {
    throw new TypeError("Credential URL sample is invalid.");
  }
  const text = `${textPrefix}${value}`;
  const start = textPrefix.length;
  return PiiCorpusSampleSchema.parse({
    id,
    text,
    spans: [
      { start, end: text.length, entityType: "url_credentials" },
      {
        start: start + emailStart,
        end: start + emailStart + emailAddress.length,
        entityType: "email",
      },
    ],
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
    createSample("pii-email-4", "Route a copy to ", "casey.sample@example.test", "email"),
    createSample("pii-email-5", "The test mailbox is ", "qa-team@example.test", "email"),
    createSample("pii-email-6", "Contact ", "morgan_example@example.test", "email"),
    createSample("pii-phone-1", "Call ", "+14155550123", "phone"),
    createSample("pii-phone-2", "The demo number is ", "(415) 555-0132", "phone"),
    createSample("pii-phone-3", "For a test call use ", "415-555-0199", "phone"),
    createSample("pii-phone-4", "The sample hotline is ", "+12025550123", "phone"),
    createSample("pii-phone-5", "Use the demo line ", "212-555-0107", "phone"),
    createSample("pii-phone-6", "The test contact number is ", "212 555 0114", "phone"),
    createSample("pii-phone-7", "Dial the synthetic office at ", "(312) 555 0198", "phone"),
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
    createSample("pii-card-3", "The synthetic charge uses ", "5555555555554444", "credit_card"),
    createSample("pii-card-4", "Use the sandbox payment card ", "378282246310005", "credit_card"),
    createSample("pii-card-5", "The test checkout card is ", "6011111111111117", "credit_card"),
    createSample("pii-iban-1", "The demo transfer uses ", "GB82WEST12345698765432", "iban"),
    createSample("pii-iban-2", "The test account is ", "DE89370400440532013000", "iban"),
    createSample(
      "pii-iban-3",
      "The synthetic mandate uses ",
      "FR1420041010050500013M02606",
      "iban",
    ),
    createSample("pii-iban-4", "Use the sandbox account ", "NL91ABNA0417164300", "iban"),
    createSample("pii-iban-5", "The demo settlement account is ", "CH9300762011623852957", "iban"),
  ];
}

function ipSamples(): PiiCorpusSample[] {
  return [
    createSample("pii-ip-1", "Connect to ", "192.0.2.10", "ip_address"),
    createSample("pii-ip-2", "The documentation address is ", "2001:db8::1", "ip_address"),
    createSample("pii-ip-3", "The synthetic node uses ", "198.51.100.42", "ip_address"),
    createSample("pii-ip-4", "Reach the test service at ", "203.0.113.17", "ip_address"),
    createSample("pii-ip-5", "The IPv6 fixture is ", "2001:db8:85a3::8a2e:370:7334", "ip_address"),
    createSample("pii-ip-6", "The sandbox address is ", "2001:db8:1234:5678::1", "ip_address"),
  ];
}

function keySamples(): PiiCorpusSample[] {
  const placeholderKey = `ghp_${"0".repeat(36)}`;
  const placeholderJwt = [
    "eyJ" + "hbGciOiJub25lIn0",
    "eyJzdWIiOiJ0ZXN0In0",
    "signatureplaceholder123",
  ].join(".");
  return [
    createSample("pii-key-1", "The fake service key is ", "AKIA0000000000000000", "api_key"),
    createSample("pii-key-2", "The placeholder token is ", placeholderKey, "api_key"),
    createSample("pii-key-3", "The demo access key is ", `AKIA${"1".repeat(16)}`, "api_key"),
    createSample("pii-key-4", "The fake GitHub token is ", `ghp_${"A".repeat(36)}`, "api_key"),
    createSample("pii-key-5", "The synthetic JWT is ", placeholderJwt, "api_key"),
  ];
}

function credentialUrl(
  protocol: "http" | "https",
  username: string,
  password: string,
  host: string,
): string {
  return `${protocol}://${username}:${password}@${host}`;
}

function urlSamples(): PiiCorpusSample[] {
  const firstCredentialUrl = credentialUrl("https", "demo-user", "synthetic-pass", "localhost");
  const secondCredentialUrl = credentialUrl("http", "test-user", "placeholder-pass", "localhost");
  const thirdCredentialUrl = credentialUrl("https", "sample-user", "fake-pass", "service.invalid");
  const fourthCredentialUrl = credentialUrl(
    "http",
    "demo-user",
    "placeholder-pass",
    "api.example.test",
  );
  const fifthCredentialUrl = credentialUrl(
    "https",
    "fixture-user",
    "test-password",
    "sandbox.example.test",
  );
  return [
    createSample("pii-url-1", "The demo URL is ", firstCredentialUrl, "url_credentials"),
    createSample(
      "pii-url-2",
      "Use this synthetic endpoint ",
      secondCredentialUrl,
      "url_credentials",
    ),
    createCredentialUrlSample(
      "pii-url-3",
      "The synthetic service URL is ",
      thirdCredentialUrl,
      "fake-pass@service.invalid",
    ),
    createCredentialUrlSample(
      "pii-url-4",
      "Use the test connection ",
      fourthCredentialUrl,
      "placeholder-pass@api.example.test",
    ),
    createCredentialUrlSample(
      "pii-url-5",
      "The fixture endpoint is ",
      fifthCredentialUrl,
      "test-password@sandbox.example.test",
    ),
  ];
}

function networkSamples(): PiiCorpusSample[] {
  return [...ipSamples(), ...keySamples(), ...urlSamples()];
}

function identitySamples(): PiiCorpusSample[] {
  return [
    createSample("pii-person-1", "The assigned reviewer is ", "Alice Example", "person_name"),
    createSample("pii-person-2", "The test operator is ", "Grace Sample", "person_name"),
    createSample("pii-person-3", "The sample profile belongs to ", "Jordan Sample", "person_name"),
    createSample("pii-person-4", "The synthetic author is ", "Casey Sample", "person_name"),
    createSample("pii-person-5", "The demo account owner is ", "Morgan Example", "person_name"),
    createSample("pii-person-6", "The test approver is ", "Riley Placeholder", "person_name"),
    createSample("pii-location-1", "The synthetic location is ", "Paris", "location"),
    createSample("pii-location-2", "The test office is in ", "London", "location"),
    createSample("pii-location-3", "The demo destination is ", "New York", "location"),
    createSample("pii-location-4", "The sandbox region is ", "Tokyo", "location"),
    createSample("pii-location-5", "The test site is in ", "Ottawa", "location"),
    createSample("pii-location-6", "The synthetic hub is ", "Berlin", "location"),
    createSample("pii-location-7", "The demo endpoint is in ", "Sydney", "location"),
  ];
}

function negativeSamples(): PiiCorpusSample[] {
  return [
    createNegative("pii-negative-order", "Order ORD-987654321012 is queued for processing."),
    createNegative("pii-negative-order-2", "Batch 12345678901234 is ready for shipment."),
    createNegative("pii-negative-timestamp", "The fixture was created at 2025-06-15T12:34:56Z."),
    createNegative("pii-negative-timestamp-2", "The log entry time is 2024-11-03 09:08:07 UTC."),
    createNegative("pii-negative-date-1", "The test window starts on 2025-06-15."),
    createNegative("pii-negative-date-2", "The fixture expires on 15-06-2025."),
    createNegative("pii-negative-version", "The test runner reports version v26.12.0."),
    createNegative(
      "pii-negative-version-2",
      "Dependency version 3.14.159 is pinned for this test.",
    ),
    createNegative("pii-negative-luhn", "The invalid test card is 4111111111111112."),
    createNegative("pii-negative-luhn-2", "Reject the checksum-invalid number 4000000000000003."),
    createNegative("pii-negative-ip", "The invalid documentation address is 999.999.999.999."),
    createNegative("pii-negative-ip-2", "The malformed IPv4 fixture is 300.1.1.1."),
    createNegative("pii-negative-ipv6", "The invalid IPv6 test value is 2001:db8::gggg."),
    createNegative("pii-negative-email", "The malformed address is reader@-example.test."),
    createNegative("pii-negative-url", "The public test URL is https://example.test/status."),
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
