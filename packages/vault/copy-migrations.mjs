// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsPath = fileURLToPath(new URL("./dist/migrations", import.meta.url));
await rm(migrationsPath, { recursive: true, force: true });
await mkdir(migrationsPath, { recursive: true });
await cp(
  fileURLToPath(new URL("./migrations", import.meta.url)),
  fileURLToPath(new URL("./dist/migrations/vault", import.meta.url)),
  { recursive: true },
);
