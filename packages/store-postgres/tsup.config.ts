// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// eslint-disable-next-line import-x/no-default-export -- tsup config files require a default export.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node26",
  sourcemap: true,
  clean: true,
  bundle: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@rovinos\//],
  external: [/^node:/u, "ajv", "ajv-formats", "pg", "yaml", "zod"],
  async onSuccess() {
    const migrationsPath = fileURLToPath(new URL("./dist/migrations", import.meta.url));
    await rm(migrationsPath, { recursive: true, force: true });
    await mkdir(migrationsPath, { recursive: true });
    await cp(
      fileURLToPath(new URL("./migrations/postgres", import.meta.url)),
      fileURLToPath(new URL("./dist/migrations/postgres", import.meta.url)),
      { recursive: true },
    );
  },
  dts: {
    entry: "src/index.ts",
    resolve: true,
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@rovinos/*": ["../*/src/index.ts"],
        "@rovinos/store/*": ["../store/src/*"],
      },
    },
  },
  esbuildOptions(options) {
    Object.assign(options, { conditions: ["source", "node"] });
  },
});
