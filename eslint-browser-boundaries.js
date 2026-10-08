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
