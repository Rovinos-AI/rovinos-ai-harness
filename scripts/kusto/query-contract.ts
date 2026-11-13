// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const safeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const attributesSchema = z.record(z.string(), safeValueSchema);

/** Zod contract for a SafeEvent converted to the ADX HarnessLogs row shape. */
export const kustoLogFixtureSchema = z
  .object({
    Timestamp: z.iso.datetime(),
    ObservedTimestamp: z.iso.datetime(),
    TraceID: z.string(),
    SpanID: z.string(),
    SeverityText: z.string(),
    SeverityNumber: z.number().int(),
    Body: z.string(),
    ResourceAttributes: attributesSchema,
    LogsAttributes: attributesSchema,
  })
  .strict();

/** Inferred row shape for the `HarnessLogs` Kusto table. */
export type KustoLogFixture = z.infer<typeof kustoLogFixtureSchema>;

const queryResultRowsSchema = z.array(z.record(z.string(), safeValueSchema));
/** Zod contract for query result rows and their committed golden file. */
export const kustoQueryGoldensSchema = z.record(z.string(), queryResultRowsSchema);
/** Inferred query-result golden contract. */
export type KustoQueryGoldens = z.infer<typeof kustoQueryGoldensSchema>;

/** Names of all KQL files covered by the emulator contract. */
export const kustoQueryNames = [
  "run_success_rate",
  "model_latency_percentiles",
  "cost_and_repair_rate",
  "tool_timeouts",
  "approval_wait",
  "pii_actions",
  "resume_counts",
  "sentinel_trips",
] as const;

/** Validates the query-result fixture against the full set of named Kusto queries. */
export function assertKustoQueryGoldens(goldens: KustoQueryGoldens): void {
  for (const name of kustoQueryNames) {
    if (goldens[name] === undefined) {
      throw new TypeError("kusto_query_golden_missing");
    }
  }
  if (Object.keys(goldens).length !== kustoQueryNames.length) {
    throw new TypeError("kusto_query_golden_unexpected");
  }
}

/** Validates query rows returned by the Kusto SDK before comparing them to goldens. */
export function parseKustoQueryRows(value: unknown): KustoQueryGoldens[string] {
  return queryResultRowsSchema.parse(value);
}

/** Parses committed JSONL fixture rows through the repository's bounded JSON parser. */
export function parseKustoLogFixtures(contents: string): KustoLogFixture[] {
  const lines = contents.trim().split("\n");
  if (lines.length === 0 || lines[0] === "") {
    throw new TypeError("kusto_fixtures_empty");
  }
  return lines.map((line) => parseJson(kustoLogFixtureSchema, line));
}

/** Parses committed expected query rows through the repository's bounded JSON parser. */
export function parseKustoQueryGoldens(contents: string): KustoQueryGoldens {
  return parseJson(kustoQueryGoldensSchema, contents);
}
