// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function findRegistrationFiles(directory: string, root: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findRegistrationFiles(path, root);
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }
    const source = readFileSync(path, "utf8");
    return /\b(?:defineSpan|defineSemconvSpan|defineLogRecord)\s*\(/u.test(source)
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  });
}

/** Finds every production source file that declares span or log telemetry definitions. */
export function findTelemetryRegistrationSources(root: string): string[] {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceDirectory = join(root, "packages", entry.name, "src");
      return existsSync(sourceDirectory) ? findRegistrationFiles(sourceDirectory, root) : [];
    })
    .sort();
}
