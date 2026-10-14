// SPDX-License-Identifier: Apache-2.0
// Tests that start a runtime without an explicit dataDir fall back to HARNESS_DATA_DIR and then to
// process.cwd(). Since the runtime always opens vault.db (13.12), that wrote database files into
// the repository root. Give every test worker its own temporary data directory instead.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DATA_DIR ??= mkdtempSync(join(tmpdir(), "harness-test-data-"));
