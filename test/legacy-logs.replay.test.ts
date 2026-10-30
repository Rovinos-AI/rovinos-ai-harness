// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { foldRunState } from "@rovinos/core";
import {
  compareGoldenSignature,
  createGoldenSignature,
  GoldenSignatureSchema,
} from "@rovinos/replay";
import { parseJson, RawEventEnvelopeSchema, upcastEvent } from "@rovinos/schemas";
import { toSafeEvent } from "@rovinos/telemetry";
import { resumeLegacyRun, withGoldenTracing } from "./replay/golden/scenario.js";
import { LegacyLogHeaderSchema } from "./legacy-log-schema.js";

const fixturesDirectory = join(import.meta.dirname, "fixtures", "legacy-logs");

it("loads, projects, replays, and resumes every committed synthetic legacy log", async () => {
  const versions = (await readdir(fixturesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  expect(versions.length).toBeGreaterThan(0);

  for (const version of versions) {
    const directory = join(fixturesDirectory, version);
    const logFiles = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(logFiles.length).toBeGreaterThan(0);

    for (const logFile of logFiles) {
      const logText = await readFile(join(directory, logFile), "utf8");
      const lines = logText.trimEnd().split("\n");
      const headerLine = lines[0];
      if (headerLine === undefined) {
        throw new Error("Legacy log is missing its provenance header.");
      }
      const header = parseJson(LegacyLogHeaderSchema, headerLine);
      expect(header).toMatchObject({ version, containsRealData: false });

      const rawEvents = lines.slice(1).map((line) => parseJson(RawEventEnvelopeSchema, line));
      const events = rawEvents.map(upcastEvent);
      expect(events.length).toBeGreaterThan(0);
      const legacyApproval = rawEvents.find(({ type }) => type === "approval_resolved");
      expect(legacyApproval).toMatchObject({ v: 1 });
      expect(legacyApproval).not.toHaveProperty("decidedBy");
      expect(events.find(({ type }) => type === "approval_resolved")).toMatchObject({
        v: 2,
        decidedBy: "human",
      });
      expect(foldRunState(events).status).toBe("completed");
      for (const event of events) {
        expect(() => toSafeEvent(event)).not.toThrow();
      }

      const signaturePath = join(directory, "signature.json");
      const signatureText = await readFile(signaturePath, "utf8");
      const signature = parseJson(GoldenSignatureSchema, signatureText);
      expect(compareGoldenSignature(events, signature).match).toBe(true);
      expect(createGoldenSignature(events)).toEqual(signature);

      await withGoldenTracing(async () => {
        await expect(resumeLegacyRun(events)).resolves.toMatchObject({ status: "completed" });
      });
    }
  }
});
