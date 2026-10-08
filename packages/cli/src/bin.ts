// SPDX-License-Identifier: Apache-2.0
import { HARNESS_VERSION } from "@harness/schemas";
import { writeOutput } from "./output.js";

if (process.argv.includes("--version")) {
  writeOutput(`${HARNESS_VERSION}\n`);
} else {
  keepAlive();
}

function keepAlive(): void {
  let timer = setTimeout(tick, 60_000);

  function tick(): void {
    timer = setTimeout(tick, 60_000);
  }

  function shutdown(): void {
    clearTimeout(timer);
    process.exitCode = 0;
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
