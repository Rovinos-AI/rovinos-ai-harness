// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runKustoEmulatorComposeContract } from "../scripts/kusto/emulator-compose.js";

it("returns the committed aggregates for every Kusto query on the emulator", async () => {
  const output = await runKustoEmulatorComposeContract(
    `harness-kusto-queries-${String(process.pid)}`,
    "kusto-query-test-client",
  );
  expect(output).toContain("kusto_emulator_contract_passed");
}, 240_000);
