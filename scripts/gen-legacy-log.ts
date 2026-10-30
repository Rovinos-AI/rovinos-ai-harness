// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoldenSignature, renderGoldenSignatureJson } from "@rovinos/replay";
import { type Event, upcastEvent } from "@rovinos/schemas";
import { LegacyLogHeaderSchema } from "../test/legacy-log-schema.ts";
import { recordGoldenScenario } from "../test/replay/golden/scenario.ts";

const versionSchema = LegacyLogHeaderSchema.shape.version;

function legacyVersionOne(event: Event): Record<string, unknown> {
  if (event.type !== "approval_resolved") {
    return event;
  }
  const payload = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "decidedBy"));
  return { ...payload, v: 1 };
}

/** Generates a synthetic JSON Lines log and its normalized replay signature. */
export async function generateLegacyLog(root: string, version: string): Promise<void> {
  const parsedVersion = versionSchema.parse(version);
  const scenario = await recordGoldenScenario();
  const events = scenario.resolved.runs[0]?.events;
  if (events === undefined || events.length === 0) {
    throw new Error("Golden scenario did not produce an event log.");
  }
  const rawEvents = events.map(legacyVersionOne);
  const currentEvents = rawEvents.map(upcastEvent);
  const header = LegacyLogHeaderSchema.parse({
    kind: "header",
    version: parsedVersion,
    containsRealData: false,
  });
  const directory = join(root, "test/fixtures/legacy-logs", parsedVersion);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "golden.jsonl"),
    `${[header, ...rawEvents].map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "signature.json"),
    renderGoldenSignatureJson(createGoldenSignature(currentEvents)),
    "utf8",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  if (versionIndex < 0 || args.length !== 2 || args[versionIndex + 1] === undefined) {
    process.stderr.write("Usage: gen-legacy-log.ts --version <version>\n");
    process.exitCode = 2;
  } else {
    const root = fileURLToPath(new URL("../", import.meta.url));
    try {
      await generateLegacyLog(root, args[versionIndex + 1]);
      process.stdout.write("Synthetic legacy log generated.\n");
    } catch {
      process.stderr.write("Unable to generate synthetic legacy log.\n");
      process.exitCode = 1;
    }
  }
}
