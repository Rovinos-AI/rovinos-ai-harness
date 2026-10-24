// SPDX-License-Identifier: Apache-2.0
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
  external: [/^node:/u, "ajv", "ajv-formats", "better-sqlite3", "yaml", "zod"],
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
