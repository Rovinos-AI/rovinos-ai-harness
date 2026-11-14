// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applySchema, splitKustoCommands } from "./apply-schema.ts";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

describe("Kusto schema applier", () => {
  it("splits commands on blank lines and ignores empty blocks", () => {
    expect(splitKustoCommands("  .show cluster\r\n\r\n\r\n .show databases \r\n")).toEqual([
      ".show cluster",
      ".show databases",
    ]);
  });

  it("does not send the file's SPDX header as a Kusto command", () => {
    expect(splitKustoCommands("// SPDX-License-Identifier: Apache-2.0\n.show cluster")).toEqual([
      ".show cluster",
    ]);
  });

  it("executes commands in order against the selected database", async () => {
    const calls: { database: string | null; command: string }[] = [];
    const client = {
      executeMgmt: vi.fn((database: string | null, command: string): Promise<void> => {
        calls.push({ database, command });
        return Promise.resolve();
      }),
    };

    await applySchema(client, "h_test", ".create-merge table A (value:string)\n\n.alter table A");

    expect(calls).toEqual([
      { database: "h_test", command: ".create-merge table A (value:string)" },
      { database: "h_test", command: ".alter table A" },
    ]);
  });

  it("propagates command failures without executing later commands", async () => {
    const failure = new Error("management command failed");
    const client = {
      executeMgmt: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(undefined),
    };

    await expect(
      applySchema(client, "h_test", ".create-merge table A (value:string)\n\n.alter table A"),
    ).rejects.toBe(failure);
    expect(client.executeMgmt).toHaveBeenCalledTimes(2);
  });

  it("defines exporter tables, JSON mappings, and retention for every table", async () => {
    const schema = await readFile(resolve(root, "infra/kusto/schema.kql"), "utf8");
    const tables = [...schema.matchAll(/\.create-merge table (\w+)/gu)].map(
      (match) => match[1] ?? "",
    );

    expect(tables).toEqual(["HarnessTraces", "HarnessLogs", "HarnessMetrics"]);
    for (const table of tables) {
      expect(schema).toContain(
        `.create-or-alter table ${table} ingestion json mapping '${table}Mapping'`,
      );
      expect(schema).toMatch(
        new RegExp(`\\.alter-merge table ${table} policy retention softdelete = \\d+d`, "u"),
      );
    }
    expect(schema).toContain("SeverityText:string");
    expect(schema).toContain("SeverityNumber:int");
    expect(schema).toContain("ResourceAttributes:dynamic");
    expect(schema).toContain("LogsAttributes:dynamic");
  });
});
