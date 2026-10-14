// SPDX-License-Identifier: Apache-2.0
import { builtinModules } from "node:module";

export const restrictedProperties = [
  {
    object: "JSON",
    property: "parse",
    message: "Parse untrusted JSON through parseJson(schema, text).",
  },
];
export const domProperties = [
  { property: "innerHTML", message: "Use textContent or safe DOM APIs." },
  { property: "outerHTML", message: "Use safe DOM APIs." },
  { property: "insertAdjacentHTML", message: "Use safe DOM APIs." },
  { object: "document", property: "write", message: "Use safe DOM APIs." },
];

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

/** Creates a browser import restriction that permits type-only imports from one package. */
export function browserTypeOnlyImportConfiguration(restrictedPatterns, moduleName, files) {
  const [severity, options] = browserRestrictedImports(restrictedPatterns);
  return {
    files,
    rules: {
      "no-restricted-imports": [
        severity,
        {
          ...options,
          paths: [
            {
              name: moduleName,
              allowTypeImports: true,
              message: `Import only types from ${moduleName} in browser code.`,
            },
          ],
        },
      ],
    },
  };
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
