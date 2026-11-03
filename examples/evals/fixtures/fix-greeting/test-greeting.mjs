// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

if (readFileSync(new URL("./greeting.txt", import.meta.url), "utf8") !== "Hello harness.\n") {
  process.exitCode = 1;
}
