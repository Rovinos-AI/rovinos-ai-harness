// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteMigrationDirectory } from "./migration-directory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

describe("sqliteMigrationDirectory", () => {
  it("resolves migrations beside the bundled entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlite-migration-directory-"));
    temporaryDirectories.push(root);
    const migrationDirectory = join(root, "dist/migrations/sqlite");
    await mkdir(migrationDirectory, { recursive: true });

    expect(sqliteMigrationDirectory(pathToFileURL(join(root, "dist/index.js")).href)).toBe(
      `${migrationDirectory}${sep}`,
    );
  });

  it("falls back to the package migration directory for source modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlite-migration-source-"));
    temporaryDirectories.push(root);
    const migrationDirectory = join(root, "migrations/sqlite");
    await mkdir(migrationDirectory, { recursive: true });

    expect(
      sqliteMigrationDirectory(pathToFileURL(join(root, "src/migration-directory.js")).href),
    ).toBe(`${migrationDirectory}${sep}`);
  });
});
