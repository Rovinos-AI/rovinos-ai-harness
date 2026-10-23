// SPDX-License-Identifier: Apache-2.0
// Keep the test-only TypeScript program build off Vitest's worker event loop.
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import * as ts from "typescript";

const sourceFiles = ["index.ts", "harness.ts", "types.ts"];
const configPath = fileURLToPath(new URL("./tsconfig.json", import.meta.url));
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
const options = {
  ...config.options,
  declaration: true,
  emitDeclarationOnly: true,
  noEmit: false,
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
};
const rootNames = sourceFiles.map((file) =>
  fileURLToPath(new URL(`./src/${file}`, import.meta.url)),
);
const program = ts.createProgram({ rootNames, options });
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  [],
);
const output = new Map();
const result = program.emit(
  undefined,
  (fileName, text) => output.set(basename(fileName), text.trim()),
  undefined,
  true,
);
assert.equal(result.emitSkipped, false);
if (parentPort === null) {
  throw new Error("SDK declaration emit must run in a worker thread.");
}
parentPort.postMessage(
  `// SPDX-License-Identifier: Apache-2.0\n${sourceFiles
    .map((file) => {
      const declaration = output.get(file.replace(".ts", ".d.ts"));
      if (declaration === undefined) {
        throw new Error("SDK declaration output is incomplete.");
      }
      return declaration;
    })
    .join("\n\n")}\n`,
);
