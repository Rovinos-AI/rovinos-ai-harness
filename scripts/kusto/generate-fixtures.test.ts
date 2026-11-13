// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKustoFixtureJsonl, hashFixtureContents } from "./generate-fixtures.ts";

describe("Kusto fixture generator", () => {
  it("generates stable JSONL matching the committed fixture", async () => {
    const first = await generateKustoFixtureJsonl();
    const second = await generateKustoFixtureJsonl();
    const committed = await readFile(
      resolve(process.cwd(), "test/fixtures/kusto/safe-events.jsonl"),
      "utf8",
    );

    expect(hashFixtureContents(first)).toBe(hashFixtureContents(second));
    expect(first).toBe(committed);
  });
});
