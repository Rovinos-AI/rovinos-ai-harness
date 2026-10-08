// SPDX-License-Identifier: Apache-2.0
import { writeOutput } from "./output.js";

if (process.argv.includes("--version")) {
  writeOutput(`${process.env.HARNESS_VERSION ?? "0.0.0"}\n`);
} else {
  keepAlive();
}

function keepAlive(): void {
  setTimeout(keepAlive, 60_000);
}
