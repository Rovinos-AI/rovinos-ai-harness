// SPDX-License-Identifier: Apache-2.0
import { type Provider, type Scenario, type ScenarioResult } from "./model-adapter-fixtures.ts";
import { runThinScenario } from "./thin-adapters.ts";

interface ResultRow {
  readonly provider: Provider;
  readonly scenario: Scenario;
  readonly result: ScenarioResult;
}

async function runScenario(provider: Provider, scenario: Scenario): Promise<ScenarioResult> {
  try {
    return await runThinScenario(provider, scenario);
  } catch {
    return { passed: false, rawBlobRoundTrip: scenario === "multi-turn" ? false : undefined };
  }
}

function printTable(rows: readonly ResultRow[]): void {
  process.stdout.write("Approach | Provider | Scenario | Result | Raw blob round trip\n");
  for (const row of rows) {
    const result = row.result.passed ? "PASS" : "FAIL";
    let fidelity = "n/a";
    if (row.result.rawBlobRoundTrip !== undefined) {
      fidelity = row.result.rawBlobRoundTrip ? "PASS" : "FAIL";
    }
    process.stdout.write(`thin | ${row.provider} | ${row.scenario} | ${result} | ${fidelity}\n`);
  }
}

async function main(): Promise<void> {
  const rows: ResultRow[] = [];
  const providers: Provider[] = ["anthropic", "openai"];
  const scenarios: Scenario[] = ["plain-text", "forced-tool", "multi-turn"];

  for (const provider of providers) {
    for (const scenario of scenarios) {
      rows.push({
        provider,
        scenario,
        result: await runScenario(provider, scenario),
      });
    }
  }

  printTable(rows);
  if (rows.some(({ result }) => !result.passed)) {
    process.exitCode = 1;
  }
}

await main();
