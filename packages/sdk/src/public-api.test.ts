// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceFiles = ["index.ts", "harness.ts", "types.ts"] as const;
const snapshotUrl = new URL("./__golden__/public-api.d.ts.snap", import.meta.url);

function publicDeclarations(): string {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const configFile = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    {},
    configPath,
  );
  if (config.errors.length > 0) {
    throw new Error("SDK TypeScript configuration could not be loaded.");
  }
  const options: ts.CompilerOptions = {
    ...config.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
  };
  const rootNames = sourceFiles.map((file) => fileURLToPath(new URL(`./${file}`, import.meta.url)));
  const program = ts.createProgram({ rootNames, options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  const output = new Map<string, string>();
  const result = program.emit(
    undefined,
    (fileName, text) => output.set(basename(fileName), text.trim()),
    undefined,
    true,
  );
  expect(result.emitSkipped).toBe(false);
  return `// SPDX-License-Identifier: Apache-2.0\n${sourceFiles
    .map((file) => {
      const declaration = output.get(file.replace(".ts", ".d.ts"));
      if (declaration === undefined) {
        throw new Error("SDK declaration output is incomplete.");
      }
      return declaration;
    })
    .join("\n\n")}\n`;
}

describe("public SDK declaration snapshot", () => {
  it("matches the committed declaration surface", async () => {
    const actual = publicDeclarations();
    if (process.env.UPDATE_GOLDEN === "1") {
      await writeFile(snapshotUrl, actual);
    }
    expect(actual).toBe(await readFile(snapshotUrl, "utf8"));
  }, 30_000);
});
