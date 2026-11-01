// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const external = [
  /^node:/u,
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@azure/identity",
  "@azure/keyvault-secrets",
  "@google/genai",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/core",
  "@modelcontextprotocol/ext-apps",
  "@modelcontextprotocol/node",
  "@modelcontextprotocol/server",
  "@opentelemetry/api",
  "@opentelemetry/api-logs",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/semantic-conventions",
  "ajv",
  "ajv-formats",
  "better-sqlite3",
  "commander",
  "openai",
  "parse5",
  "pg",
  "tar",
  "tldts",
  "undici",
  "yaml",
  "zod",
];

// eslint-disable-next-line import-x/no-default-export -- tsup config files require a default export.
export default defineConfig({
  entry: { bin: "src/bin.ts", programmatic: "src/programmatic.ts" },
  format: ["esm"],
  target: "node26",
  sourcemap: true,
  clean: true,
  async onSuccess() {
    const migrationsPath = fileURLToPath(new URL("./dist/migrations", import.meta.url));
    const assetsPath = fileURLToPath(new URL("./dist/assets", import.meta.url));
    const webAssetsPath = fileURLToPath(new URL("./dist/assets/web", import.meta.url));
    await Promise.all([
      rm(migrationsPath, { recursive: true, force: true }),
      rm(assetsPath, { recursive: true, force: true }),
    ]);
    await mkdir(migrationsPath, { recursive: true });
    await mkdir(assetsPath, { recursive: true });
    await mkdir(webAssetsPath, { recursive: true });
    await Promise.all([
      cp(
        fileURLToPath(new URL("../store-sqlite/migrations/sqlite", import.meta.url)),
        fileURLToPath(new URL("./dist/migrations/sqlite", import.meta.url)),
        { recursive: true },
      ),
      cp(
        fileURLToPath(new URL("../store-postgres/migrations/postgres", import.meta.url)),
        fileURLToPath(new URL("./dist/migrations/postgres", import.meta.url)),
        { recursive: true },
      ),
      cp(
        fileURLToPath(new URL("../vault/migrations", import.meta.url)),
        fileURLToPath(new URL("./dist/migrations/vault", import.meta.url)),
        { recursive: true },
      ),
      cp(
        fileURLToPath(new URL("../approval-app/dist/approval.html", import.meta.url)),
        fileURLToPath(new URL("./dist/assets/approval.html", import.meta.url)),
      ),
      cp(
        fileURLToPath(new URL("../approval-app/dist/runs-console.html", import.meta.url)),
        fileURLToPath(new URL("./dist/assets/runs-console.html", import.meta.url)),
      ),
      cp(
        fileURLToPath(new URL("../approval-app/dist/input.html", import.meta.url)),
        fileURLToPath(new URL("./dist/assets/input.html", import.meta.url)),
      ),
      cp(
        fileURLToPath(new URL("../host/dist/web/index.html", import.meta.url)),
        fileURLToPath(new URL("./dist/assets/web/index.html", import.meta.url)),
      ),
      cp(
        fileURLToPath(new URL("../host/dist/web/host.js", import.meta.url)),
        fileURLToPath(new URL("./dist/assets/web/host.js", import.meta.url)),
      ),
    ]);
  },
  bundle: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@rovinos\//],
  external,
  dts: {
    entry: "src/programmatic.ts",
    resolve: true,
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@rovinos/*": ["../*/src/index.ts"],
        "@rovinos/core/*": ["../core/src/*"],
        "@rovinos/schemas/*": ["../schemas/src/*"],
        "@rovinos/store/*": ["../store/src/*"],
        "@rovinos/telemetry/*": ["../telemetry/src/*"],
      },
    },
  },
  esbuildOptions(options) {
    Object.assign(options, { conditions: ["source", "node"] });
  },
});
