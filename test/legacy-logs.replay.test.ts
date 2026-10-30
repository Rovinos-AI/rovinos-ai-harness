// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { requestHash } from "@rovinos/models";
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

it("upcasts the v1 model-request fixture while preserving legacy hash verification", async () => {
  const text = await readFile(join(fixturesDirectory, "v1", "model-request.json"), "utf8");
  const fixture = parseJson(
    z.object({ containsRealData: z.literal(false), event: RawEventEnvelopeSchema }).strict(),
    text,
  );
  const event = upcastEvent(fixture.event);
  expect(event).toMatchObject({
    type: "model_request",
    v: 2,
    requestParametersHash: null,
    requestHash: fixture.event.requestHash,
  });
  if (event.type !== "model_request") {
    throw new Error("Expected a legacy model request.");
  }
  expect(event.requestHash).toBe(
    requestHash({
      requestId: event.requestId,
      model: { provider: event.provider, model: event.model },
      messages: event.messages,
      stablePrefixMessages: 0,
    }),
  );
});

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
