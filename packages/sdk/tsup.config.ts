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
  async onSuccess() {
    const migrationsPath = fileURLToPath(new URL("./dist/migrations", import.meta.url));
    await rm(migrationsPath, { recursive: true, force: true });
    await mkdir(migrationsPath, { recursive: true });
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
    ]);
  },
  bundle: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@rovinos\//],
  external: [
    /^node:/u,
    "@anthropic-ai/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@azure/identity",
    "@azure/keyvault-secrets",
    "@google/genai",
    "@modelcontextprotocol/client",
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
    "openai",
    "parse5",
    "pg",
    "tar",
    "undici",
    "yaml",
    "zod",
  ],
  dts: {
    entry: "src/index.ts",
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
