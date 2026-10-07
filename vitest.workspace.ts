// SPDX-License-Identifier: Apache-2.0
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: [
        "packages/**/*.test.ts",
        "tools/**/*.test.ts",
        "scripts/**/*.test.ts",
        "test/**/*.test.ts",
      ],
      exclude: ["**/*.int.test.ts", "**/*.canary.test.ts", "**/*.replay.test.ts"],
    },
  },
  {
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
]);
