// SPDX-License-Identifier: Apache-2.0
// Keep the coverage floor in root config so Vitest applies it to every project.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source", "module", "browser", "development|production"],
    alias: {
      "@harness/core/testing": fileURLToPath(
        new URL("./packages/core/src/testing/index.ts", import.meta.url),
      ),
      "@harness/config": fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
      "@harness/context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@harness/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@harness/crypto": fileURLToPath(new URL("./packages/crypto/src/index.ts", import.meta.url)),
      "@harness/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
      "@harness/models": fileURLToPath(new URL("./packages/models/src/index.ts", import.meta.url)),
      "@harness/pii": fileURLToPath(new URL("./packages/pii/src/index.ts", import.meta.url)),
      "@harness/policy": fileURLToPath(new URL("./packages/policy/src/index.ts", import.meta.url)),
      "@harness/schemas": fileURLToPath(
        new URL("./packages/schemas/src/index.ts", import.meta.url),
      ),
      "@harness/store/testing": fileURLToPath(
        new URL("./packages/store/src/testing/index.ts", import.meta.url),
      ),
      "@harness/store": fileURLToPath(new URL("./packages/store/src/index.ts", import.meta.url)),
      "@harness/telemetry/testing": fileURLToPath(
        new URL("./packages/telemetry/src/testing.ts", import.meta.url),
      ),
      "@harness/telemetry": fileURLToPath(
        new URL("./packages/telemetry/src/index.ts", import.meta.url),
      ),
      "@harness/vault": fileURLToPath(new URL("./packages/vault/src/index.ts", import.meta.url)),
    },
  },
  ssr: {
    noExternal: [/^@harness\//],
    resolve: {
      conditions: ["node", "development|production"],
      externalConditions: ["node"],
    },
  },
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
        extends: true,
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
        extends: true,
        test: {
          name: "integration",
          include: ["**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "canary",
          include: ["**/*.canary.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "replay",
          include: ["**/*.replay.test.ts"],
        },
      },
    ],
  },
});
