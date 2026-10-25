// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve Postgres migrations beside a bundle, with a source-tree fallback. */
export function postgresMigrationDirectory(moduleUrl = import.meta.url): string {
  const bundledDirectory = new URL("./migrations/postgres/", moduleUrl);
  if (existsSync(fileURLToPath(bundledDirectory))) {
    return fileURLToPath(bundledDirectory);
  }
  return fileURLToPath(new URL("../migrations/postgres/", moduleUrl));
}
