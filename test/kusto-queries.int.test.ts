// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runKustoEmulatorComposeQueriesContract } from "../scripts/kusto/emulator-compose.js";

it("returns the committed aggregates for every Kusto query on the emulator", async () => {
  const output = await runKustoEmulatorComposeQueriesContract(`harness-kusto-queries-${String(process.pid)}`);
  expect(output).toContain("kusto_emulator_contract_passed");
}, 240_000);
