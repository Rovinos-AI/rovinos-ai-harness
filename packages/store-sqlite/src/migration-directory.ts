// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

/** Resolve SQLite migrations from the package root in both source and bundled layouts. */
export function sqliteMigrationDirectory(): string {
  return fileURLToPath(new URL("../migrations/sqlite/", import.meta.url));
}
