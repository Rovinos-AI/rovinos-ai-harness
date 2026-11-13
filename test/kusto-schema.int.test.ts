// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { runKustoEmulatorComposeContract } from "../scripts/kusto/emulator-compose.js";

it("applies the schema twice and ingests mapped rows in the Kusto emulator", async () => {
  const output = await runKustoEmulatorComposeContract(`harness-kusto-${String(process.pid)}`);
  expect(output).toContain("kusto_emulator_contract_passed");
}, 240_000);
