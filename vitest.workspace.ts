// SPDX-License-Identifier: Apache-2.0
// Keep the coverage floor per source file so covered siblings cannot mask gaps.
import { fileURLToPath } from "node:url";

const sourceResolution = {
  resolve: {
    alias: {
      "@harness/schemas": fileURLToPath(
        new URL("./packages/schemas/src/index.ts", import.meta.url),
      ),
    },
  },
};

export default [
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
      coverage: {
        include: ["packages/*/src/**/*.ts"],
        reportOnFailure: true,
        thresholds: {
          perFile: true,
          "packages/*/src/**/*.ts": {
            lines: 85,
          },
        },
      },
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
];
