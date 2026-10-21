// SPDX-License-Identifier: Apache-2.0
// Keep the coverage floor in root config so Vitest applies it to every project.
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { composeIntegrationSuites } from "./scripts/compose/compose-suites.js";

const composeSuiteSet = new Set<string>(composeIntegrationSuites);
const parallelIntegrationSuites = globSync("**/*.int.test.ts", {
  exclude: (path) => path === "node_modules" || path === ".tmp" || path === "dist",
}).filter((path) => !composeSuiteSet.has(path));

export default defineConfig({
  resolve: {
    conditions: ["source", "module", "browser", "development|production"],
    alias: {
      "@harness/schemas/browser": fileURLToPath(
        new URL("./packages/schemas/src/browser.ts", import.meta.url),
      ),
      "@harness/config": fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
      "@harness/schemas": fileURLToPath(
        new URL("./packages/schemas/src/index.ts", import.meta.url),
      ),
    },
  },
  ssr: {
    noExternal: [/^@harness\//],
    resolve: {
      conditions: ["source", "node", "development|production"],
    },
  },
  test: {
    // Keep runtime databases out of the repository root (see test/setup/data-dir.ts).
    setupFiles: ["./test/setup/data-dir.ts"],
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.ts",
        "packages/sandbox/runner/src/**/*.ts",
        "packages/sandbox/egress-proxy/src/**/*.ts",
      ],
      reportOnFailure: true,
      thresholds: {
        perFile: true,
        lines: 85,
      },
    },
    server: {
      deps: {
        inline: [/@modelcontextprotocol/, /eventsource/],
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
            "**/*.live.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          // An explicit list, not a project `exclude`: overriding `exclude` would drop the
          // command-line `--exclude` globs that verification and CI pass.
          include: parallelIntegrationSuites,
          globalSetup: ["./scripts/compose/build-images.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Compose suites run one file at a time (see scripts/compose/compose-suites.ts).
          name: "integration-compose",
          include: [...composeIntegrationSuites],
          fileParallelism: false,
          globalSetup: ["./scripts/compose/build-images.ts"],
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
      {
        extends: true,
        test: {
          name: "live",
          include: ["**/*.live.test.ts"],
        },
      },
    ],
  },
});
