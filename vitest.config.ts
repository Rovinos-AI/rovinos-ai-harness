// SPDX-License-Identifier: Apache-2.0
// Keep the coverage floor in root config so Vitest applies it to every project.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceResolution = {
  resolve: {
    alias: {
      "@harness/config": fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
      "@harness/schemas": fileURLToPath(
        new URL("./packages/schemas/src/index.ts", import.meta.url),
      ),
    },
  },
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reportOnFailure: true,
      thresholds: {
        perFile: true,
        lines: 85,
      },
    },
    projects: [
      {
        ...sourceResolution,
        test: {
          name: "unit",
          include: [
            "packages/**/*.test.ts",
            "tools/**/*.test.ts",
            "scripts/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "**/*.int.test.ts",
            "**/*.canary.test.ts",
            "**/*.replay.test.ts",
          ],
        },
      },
      {
        ...sourceResolution,
        test: {
          name: "integration",
          include: ["**/*.int.test.ts"],
        },
      },
      {
        test: {
          name: "canary",
          include: ["**/*.canary.test.ts"],
        },
      },
      {
        test: {
          name: "replay",
          include: ["**/*.replay.test.ts"],
        },
      },
    ],
  },
});
