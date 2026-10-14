// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
/** Read the event and vault databases, including any active SQLite sidecar files. */
export async function readDatabaseSinks(
  databases: readonly { readonly name: string; readonly path: string }[],
): Promise<[string, string][]> {
  const result: [string, string][] = [];
  for (const { name, path } of databases) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const databasePath = `${path}${suffix}`;
      if (suffix !== "" && !existsSync(databasePath)) {
        continue;
      }
      const bytes = await readFile(databasePath);
      result.push([`${name}${suffix}`, bytes.toString("latin1")]);
    }
  }
  return result;
}

/**
 * Scan committed cassette and fixture files for synthetic canary-shaped values.
 *
 * @param repositoryRoot - Repository checkout root.
 * @returns Paths of fixture files containing a canary-like pattern.
 */
export async function scanCommittedFixtures(repositoryRoot: string): Promise<string[]> {
  const matches: string[] = [];
  const queue = [repositoryRoot];
  const detector =
    /\w[\w.%+-]*@[\w.-]+\.[A-Z]{2,}|(?:\+?1[- .]?)?\(?\d{3}\)?[- .]?\d{3}[- .]\d{4}|\b\d{13,19}\b|hsk_live_[a-f0-9]{24}|Ada-[a-f0-9]{8}|Grace-[a-f0-9]{8}|Katherine-[a-f0-9]{8}|Margaret-[a-f0-9]{8}/iu;

  while (queue.length > 0) {
    const directory = queue.pop();
    if (directory === undefined) {
      continue;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (![".git", ".yarn", "dist", "node_modules"].includes(entry.name)) {
          queue.push(join(directory, entry.name));
        }
        continue;
      }
      const path = join(directory, entry.name);
      const segments = relative(repositoryRoot, path).split(sep);
      const fixture = segments.includes("__fixtures__");
      const cassette = segments[0] === "test" && path.endsWith(".cassette.json");
      if ((fixture || cassette) && detector.test(await readFile(path, "utf8"))) {
        matches.push(path);
      }
    }
  }
  return matches;
}
