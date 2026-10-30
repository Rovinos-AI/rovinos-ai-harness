// SPDX-License-Identifier: Apache-2.0
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileCassetteStore, ProviderResultSchema, requestHash } from "@rovinos/models";
import {
  assertBaselineUpdateAllowed,
  createGoldenSignature,
  renderGoldenSignatureJson,
  replayRun,
} from "@rovinos/replay";
import { Code } from "@rovinos/schemas";
import type { GoldenScenario } from "../test/replay/golden/scenario.ts";
import { recordGoldenScenario, withGoldenTracing } from "../test/replay/golden/scenario.ts";

const GOLDEN_DIRECTORY = "test/replay/golden";

/** Options for recording or explicitly updating the golden replay fixture. */
export interface ReplayGoldenOptions {
  readonly command: "record" | "update";
  readonly directory?: string;
  readonly inCi?: boolean;
  readonly forceInCi?: boolean;
}

async function writeCassette(directory: string, scenario: GoldenScenario): Promise<void> {
  const cassettePath = join(directory, "cassette.json");
  await rm(cassettePath, { force: true });
  const cassette = new FileCassetteStore(cassettePath);
  for (const [index, captured] of scenario.model.requests.entries()) {
    const completion = scenario.responses[index];
    if (completion === undefined) {
      continue;
    }
    const response = ProviderResultSchema.parse({
      parts: completion.parts,
      usage: completion.usage,
      finishReason: completion.finishReason,
      latencyMs: completion.latencyMs,
    });
    await cassette.set({
      hash: requestHash(captured.request),
      response,
    });
  }
}

/** Records the synthetic scenario and writes its cassette and normalized replay signature. */
export async function runReplayGolden(options: ReplayGoldenOptions): Promise<void> {
  if (options.command === "update") {
    assertBaselineUpdateAllowed({
      inCi: options.inCi === true,
      forceInCi: options.forceInCi === true,
    });
  }
  const directory = resolve(options.directory ?? GOLDEN_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await withGoldenTracing(async () => {
    const scenario = await recordGoldenScenario();
    const outcome = await replayRun(scenario.resolved, {
      config: scenario.config,
      policy: scenario.policy,
    });
    if (outcome.status !== "completed" || outcome.divergence !== undefined) {
      throw new Error("Golden scenario replay did not complete.");
    }
    await writeCassette(directory, scenario);
    await writeFile(
      join(directory, "signature.json"),
      renderGoldenSignatureJson(
        createGoldenSignature([...outcome.events, ...scenario.coverageEvents]),
      ),
      "utf8",
    );
  });
}

function commandOptions(args: readonly string[]): ReplayGoldenOptions {
  const command = args[0];
  if (command !== "record" && command !== "update") {
    throw new Error("Usage: yarn replay:record | yarn replay:update [--force-in-ci]");
  }
  const forceInCi = args.includes("--force-in-ci");
  return {
    command,
    inCi: Boolean(process.env.CI),
    forceInCi,
  };
}

async function main(args: readonly string[]): Promise<void> {
  await runReplayGolden(commandOptions(args));
  process.stdout.write("Golden replay fixtures recorded.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Code.safeParse(error.code).success
        ? Code.parse(error.code)
        : "replay_golden_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
