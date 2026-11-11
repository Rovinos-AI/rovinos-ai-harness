// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseJson } from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const rootModules = join(repositoryRoot, "node_modules");
let consumerRoot: string | undefined;
const extensionsExportsSchema = z.object({
  exports: z.object({
    ".": z.object({ default: z.string() }),
    "./testing": z.object({ default: z.string() }),
  }),
});

async function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<void> {
  try {
    await execFileAsync(command, [...arguments_], { cwd });
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
      const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
      const output = [stderr, stdout].filter((value) => value.length > 0).join("\n");
      if (output.length > 0) {
        throw new Error(output);
      }
    }
    throw error;
  }
}

async function linkInstalledDependencies(targetModules: string): Promise<void> {
  await mkdir(targetModules, { recursive: true });
  const entries = await readdir(rootModules, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".bin" && entry.name !== "@rovinos")
      .map(async (entry) => {
        const source = join(rootModules, entry.name);
        const target = join(targetModules, entry.name);
        if (entry.name.startsWith("@")) {
          await mkdir(target, { recursive: true });
          const scopedEntries = await readdir(source, { withFileTypes: true });
          await Promise.all(
            scopedEntries.map((scopedEntry) =>
              symlink(join(source, scopedEntry.name), join(target, scopedEntry.name), "junction"),
            ),
          );
          return;
        }
        await symlink(source, target, "junction");
      }),
  );
}

async function packAndExtract(packageName: "sdk" | "extensions"): Promise<void> {
  if (consumerRoot === undefined) {
    throw new Error("extensions_consumer_workspace_missing");
  }
  const packageDirectory = join(repositoryRoot, "packages", packageName);
  const archivePath = join(consumerRoot, `${packageName}.tgz`);
  const targetDirectory = join(consumerRoot, "node_modules", "@rovinos", packageName);
  await mkdir(targetDirectory, { recursive: true });
  await runCommand("corepack", ["yarn", "pack", "--out", archivePath], packageDirectory);
  await runCommand(
    "tar",
    ["-xzf", archivePath, "-C", targetDirectory, "--strip-components=1"],
    repositoryRoot,
  );
}

async function buildConsumer(projectDirectory: string, entry: string): Promise<void> {
  const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  await runCommand(
    process.execPath,
    [
      compiler,
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--outDir",
      "dist",
      entry,
    ],
    projectDirectory,
  );
}

async function runConsumer(projectDirectory: string, entry: string): Promise<void> {
  await runCommand(process.execPath, [join(projectDirectory, "dist", entry)], projectDirectory);
}

afterEach(async () => {
  if (consumerRoot !== undefined) {
    await rm(consumerRoot, { recursive: true, force: true });
    consumerRoot = undefined;
  }
});

describe("packed extensions consumer", () => {
  it("builds and runs SDK-only and explicit extensions/testing consumers outside the workspace", async () => {
    consumerRoot = await mkdtemp(join(tmpdir(), "rovinos-extensions-consumer-"));
    const nodeModules = join(consumerRoot, "node_modules");
    await linkInstalledDependencies(nodeModules);
    await mkdir(join(nodeModules, "@rovinos"), { recursive: true });
    await packAndExtract("sdk");

    const sdkOnly = join(consumerRoot, "sdk-only");
    await mkdir(sdkOnly);
    await writeFile(join(sdkOnly, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(sdkOnly, "consumer.ts"),
      [
        'import { ExtensionDefinitionSchema } from "@rovinos/sdk";',
        "if (!ExtensionDefinitionSchema) throw new Error('sdk_contract_missing');",
      ].join("\n"),
    );
    await buildConsumer(sdkOnly, "consumer.ts");
    await runConsumer(sdkOnly, "consumer.js");

    await packAndExtract("extensions");
    const extensionsPackage = parseJson(
      extensionsExportsSchema,
      await readFile(join(nodeModules, "@rovinos", "extensions", "package.json"), "utf8"),
    );
    expect(extensionsPackage.exports?.["."]?.default).toBe("./dist/index.js");
    expect(extensionsPackage.exports?.["./testing"]?.default).toBe("./dist/testing.js");
    const runtimeEntry = await readFile(
      join(nodeModules, "@rovinos", "extensions", "dist", "index.js"),
      "utf8",
    );
    expect(runtimeEntry).not.toMatch(/(?:vitest|testing\.js)/u);

    const consumer = join(consumerRoot, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(consumer, "consumer.ts"),
      [
        'import { composeExtensions, defineExtension } from "@rovinos/extensions";',
        'import { ExtensionDefinitionSchema, type ExtensionRegistration } from "@rovinos/sdk";',
        'import { z } from "zod";',
        "const configSchema = z.object({ endpoint: z.url() });",
        "const definition = defineExtension({",
        "  manifest: {",
        '    id: "example.lookup", version: "1.0.0", sdkRange: ">=0.3.0 <0.4.0", schemaVersion: 1,',
        "    capabilities: { required: [], optional: [] },",
        "  },",
        "  configSchema,",
        "  createContributions: (config) => {",
        "    const endpoint: string = config.endpoint;",
        "    return endpoint.length > 0 ? {} : {};",
        "  },",
        "});",
        "const registration = { namespace: 'lookup', definition, grants: [] } satisfies ExtensionRegistration<typeof definition>;",
        "if (!ExtensionDefinitionSchema.safeParse(definition).success) throw new Error('invalid_definition');",
        "if (composeExtensions([registration])[0] !== registration) throw new Error('composition_failed');",
        'if ("createTestRegistration" in await import("@rovinos/extensions")) throw new Error("testing_export_in_default_entry");',
      ].join("\n"),
    );
    await buildConsumer(consumer, "consumer.ts");
    await runConsumer(consumer, "consumer.js");

    await writeFile(
      join(consumer, "testing-consumer.ts"),
      [
        'import { createTestRegistration } from "@rovinos/extensions/testing";',
        'import type { ExtensionRegistration } from "@rovinos/sdk";',
        'import { z } from "zod";',
        "const configSchema = z.object({});",
        "const registration = {",
        "  namespace: 'lookup',",
        "  definition: {",
        '    manifest: { id: "example.lookup", version: "1.0.0", sdkRange: ">=0.3.0 <0.4.0", schemaVersion: 1, capabilities: { required: [], optional: [] } },',
        "    configSchema,",
        "    createContributions: () => ({}),",
        "  },",
        "  grants: [],",
        "} satisfies ExtensionRegistration;",
        "if (createTestRegistration(registration).namespace !== 'lookup') throw new Error('testing_import_failed');",
      ].join("\n"),
    );
    await buildConsumer(consumer, "testing-consumer.ts");
    await runConsumer(consumer, "testing-consumer.js");
  }, 60_000);
});
