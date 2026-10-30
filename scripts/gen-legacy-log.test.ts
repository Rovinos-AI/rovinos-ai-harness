// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoldenSignatureSchema } from "@rovinos/replay";
import { parseJson, RawEventEnvelopeSchema, upcastEvent } from "@rovinos/schemas";
import { withGoldenTracing } from "../test/replay/golden/scenario.js";
import { LegacyLogHeaderSchema } from "../test/legacy-log-schema.js";
import { generateLegacyLog } from "./gen-legacy-log.js";

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gen-legacy-log-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generateLegacyLog", () => {
  it("writes a synthetic versioned log and a stable normalized signature", async () => {
    const root = createRoot();
    await withGoldenTracing(() => generateLegacyLog(root, "v1"));

    const directory = join(root, "test/fixtures/legacy-logs/v1");
    const logFiles = readdirSync(directory);
    expect(logFiles.sort()).toEqual(["golden.jsonl", "signature.json"]);

    const logLines = readFileSync(join(directory, "golden.jsonl"), "utf8").trimEnd().split("\n");
    const headerLine = logLines[0];
    if (headerLine === undefined) {
      throw new Error("Generated log is missing its provenance header.");
    }
    expect(parseJson(LegacyLogHeaderSchema, headerLine)).toMatchObject({
      version: "v1",
      containsRealData: false,
    });
    const rawEvents = logLines.slice(1).map((line) => parseJson(RawEventEnvelopeSchema, line));
    const events = rawEvents.map(upcastEvent);
    const legacyApproval = rawEvents.find(({ type }) => type === "approval_resolved");
    expect(legacyApproval).toMatchObject({ v: 1 });
    expect(legacyApproval).not.toHaveProperty("decidedBy");
    expect(events.some((event) => event.type === "approval_resolved" && event.v === 2)).toBe(true);

    const signature = parseJson(
      GoldenSignatureSchema,
      readFileSync(join(directory, "signature.json"), "utf8"),
    );
    expect(signature).toMatchObject({ containsRealData: false });
  });

  it("rejects unsafe output directory versions", async () => {
    await expect(generateLegacyLog(createRoot(), "../outside")).rejects.toThrow();
  });
});
