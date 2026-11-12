// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCHMARK_PROFILES, runBenchmarks } from "./scenarios.js";

function parseArgs(args: readonly string[]): { profile: "smoke" | "nightly"; output: string } {
  const options = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator <= 2 || !arg.startsWith("--")) {
      throw new Error("invalid_arguments");
    }
    options.set(arg.slice(2, separator), arg.slice(separator + 1));
  }
  const profile = options.get("profile") ?? "nightly";
  const output = options.get("output");
  if ((profile !== "smoke" && profile !== "nightly") || output === undefined) {
    throw new Error("required_arguments_missing");
  }
  return { profile, output };
}

async function main(args: readonly string[]): Promise<number> {
  try {
    const options = parseArgs(args);
    const result = await runBenchmarks(BENCHMARK_PROFILES[options.profile]);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Wrote ${String(result.metrics.length)} performance metrics.\n`);
    return 0;
  } catch {
    process.stderr.write("Performance benchmark run failed.\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
