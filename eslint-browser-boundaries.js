// SPDX-License-Identifier: Apache-2.0
import { builtinModules } from "node:module";

const nodeModuleNames = [
  ...new Set(
    builtinModules.flatMap((moduleName) => {
      const bareName = moduleName.replace(/^node:/u, "");
      return [bareName, `node:${bareName}`];
    }),
  ),
].flatMap((moduleName) => [moduleName, `${moduleName}/*`]);

/** Creates an import restriction for Node.js built-ins in browser-only code. */
export function browserRestrictedImports(restrictedPatterns) {
  return [
    "error",
    {
      patterns: [
        ...restrictedPatterns,
        {
          group: nodeModuleNames,
          message: "Browser code cannot import Node.js modules.",
        },
      ],
    },
  ];
}

/** Creates CLI output stream restrictions and permits the output boundary. */
export function cliOutputConfiguration(restrictedProperties) {
  const streamProperties = ["stdout", "stderr"].map((property) => ({
    object: "process",
    property,
    message: "Write CLI output only through packages/cli/src/output.ts.",
  }));
  return [
    {
      files: ["packages/cli/src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-properties": ["error", ...restrictedProperties, ...streamProperties],
      },
    },
    {
      files: ["packages/cli/src/output.ts"],
      rules: { "no-restricted-properties": ["error", ...restrictedProperties] },
    },
  ];
}
