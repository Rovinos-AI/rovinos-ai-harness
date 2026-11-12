// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

// eslint-disable-next-line import-x/no-default-export -- tsup config files require a default export.
export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  format: ["esm"],
  target: "node26",
  sourcemap: true,
  clean: true,
  bundle: true,
  skipNodeModulesBundle: true,
  external: ["@rovinos/sdk"],
  dts: {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@rovinos/sdk": ["../sdk/src/index.ts"],
      },
    },
  },
  esbuildOptions(options) {
    Object.assign(options, { conditions: ["source", "node"] });
  },
});
