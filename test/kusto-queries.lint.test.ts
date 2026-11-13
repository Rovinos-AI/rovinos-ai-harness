// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { kustoQueryNames } from "../scripts/kusto/query-contract.js";

const root = resolve(process.cwd());

describe("Kusto query catalog lint", () => {
  it("uses the standard header and only reads cataloged attributes in each query helper", async () => {
    const queryDirectory = resolve(root, "infra/kusto/queries");
    const queryFiles = (await readdir(queryDirectory)).filter((file) => file.endsWith(".kql")).sort();
    const catalog = await readFile(resolve(root, "docs/telemetry/attribute-catalog.md"), "utf8");
    const catalogAttributes = new Set(
      [...catalog.matchAll(/^\| `(harness\.[a-z0-9_.]+)` \|/gmu)].map((match) => match[1]),
    );

    expect(queryFiles).toEqual(kustoQueryNames.map((name) => `${name}.kql`).sort());
    for (const file of queryFiles) {
      const source = await readFile(resolve(queryDirectory, file), "utf8");
      expect(source.startsWith("// SPDX-License-Identifier: Apache-2.0\n")).toBe(true);

      const attributeReads = [...source.matchAll(/LogsAttributes\s*\[\s*"([^"]+)"\s*\]/gu)];
      const allAttributeAccesses = [...source.matchAll(/LogsAttributes\s*\[/gu)];
      expect(attributeReads.length).toBeGreaterThan(0);
      expect(allAttributeAccesses).toHaveLength(attributeReads.length);
      expect(source.indexOf("};")).toBeGreaterThan(0);
      for (const read of attributeReads) {
        expect(catalogAttributes.has(read[1] ?? "")).toBe(true);
        expect(read.index).toBeLessThan(source.indexOf("};"));
      }
    }
  });
});
