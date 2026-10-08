// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import importX from "eslint-plugin-import-x";
import jsdoc from "eslint-plugin-jsdoc";
import nodePlugin from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import regexp from "eslint-plugin-regexp";
import unicorn from "eslint-plugin-unicorn";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { harnessPlugin } from "@harness/eslint-plugin-harness";
import { browserRestrictedImports } from "./eslint-browser-boundaries.js";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const testFiles = [
  "**/*.test.{js,mjs,ts,tsx}",
  "**/*.int.test.{js,mjs,ts,tsx}",
  "**/*.canary.test.{js,mjs,ts,tsx}",
  "**/*.replay.test.{js,mjs,ts,tsx}",
];
const testRules = new Set([
  "complexity",
  "jsdoc/check-tag-names",
  "jsdoc/no-types",
  "jsdoc/require-jsdoc",
  "max-depth",
  "max-lines",
  "max-lines-per-function",
  "max-params",
]);
const restrictedImportGroups = {
  observability: {
    group: ["pino", "@opentelemetry/sdk-*"],
    message: "Use the approved telemetry boundary in packages/telemetry.",
  },
  childProcess: {
    group: ["child_process", "node:child_process"],
    message: "Child processes are restricted to packages/sandbox and scripts.",
  },
  parsers: {
    group: ["ajv", "yaml"],
    message: "Use the schema parsing helpers in packages/schemas.",
  },
};
const restrictedProperties = [
  {
    object: "JSON",
    property: "parse",
    message: "Parse untrusted JSON through parseJson(schema, text).",
  },
];
const domProperties = [
  { property: "innerHTML", message: "Use textContent or safe DOM APIs." },
  { property: "outerHTML", message: "Use safe DOM APIs." },
  { property: "insertAdjacentHTML", message: "Use safe DOM APIs." },
  { object: "document", property: "write", message: "Use safe DOM APIs." },
];

function restrictedImports({ telemetry = false, childProcess = false, parsers = false } = {}) {
  const patterns = [
    ...(!telemetry ? [restrictedImportGroups.observability] : []),
    ...(!childProcess ? [restrictedImportGroups.childProcess] : []),
    ...(!parsers ? [restrictedImportGroups.parsers] : []),
  ];
  return ["error", { patterns }];
}

function errorizeWarnings(configuration) {
  return configuration.map((entry) => {
    if (!entry.rules) {
      return entry;
    }
    const rules = Object.fromEntries(
      Object.entries(entry.rules).map(([name, setting]) => {
        const values = Array.isArray(setting) ? setting : [setting];
        return [
          name,
          values[0] === "warn" || values[0] === 1 ? ["error", ...values.slice(1)] : setting,
        ];
      }),
    );
    return { ...entry, rules };
  });
}

function typescriptOnly(configurations) {
  return configurations.map((entry) => ({
    ...entry,
    files: ["**/*.{ts,tsx,mts,cts}"],
  }));
}

function typedPluginJavaScript(configurations) {
  return configurations.map((entry) => ({
    ...entry,
    files: ["tools/eslint-plugin-harness/src/index.js"],
  }));
}

const configuration = [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "docs/api/**",
      "**/*.generated.*",
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  ...typescriptOnly(tseslint.configs.strictTypeChecked),
  ...typescriptOnly(tseslint.configs.stylisticTypeChecked),
  ...typedPluginJavaScript(tseslint.configs.strictTypeChecked),
  ...typedPluginJavaScript(tseslint.configs.stylisticTypeChecked),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
    plugins: {
      "import-x": importX,
      n: nodePlugin,
      promise,
      regexp,
      unicorn,
      "eslint-comments": comments,
      jsdoc,
      harness: harnessPlugin,
    },
    rules: {
      eqeqeq: "error",
      "no-console": "error",
      curly: ["error", "all"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-param-reassign": ["error", { props: true }],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "no-nested-ternary": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use a string-literal union instead of an enum.",
        },
        { selector: "ForInStatement", message: "Use Object.keys or Object.entries instead." },
        { selector: "LabeledStatement", message: "Use structured control flow instead of labels." },
      ],
      complexity: ["error", 15],
      "max-depth": ["error", 4],
      "max-params": ["error", 4],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "no-restricted-imports": restrictedImports(),
      "import-x/no-cycle": "error",
      "import-x/no-extraneous-dependencies": ["error", { devDependencies: true }],
      "import-x/no-duplicates": "error",
      "import-x/no-self-import": "error",
      "import-x/no-useless-path-segments": "error",
      "import-x/no-relative-packages": "error",
      "import-x/extensions": ["error", "always", { ignorePackages: true }],
      "import-x/no-default-export": "error",
      "n/prefer-node-protocol": "error",
      "n/no-deprecated-api": "error",
      "n/no-process-exit": "error",
      "promise/param-names": "error",
      "promise/no-multiple-resolved": "error",
      ...regexp.configs.recommended.rules,
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-misleading-capturing-group": "error",
      "unicorn/throw-new-error": "error",
      "unicorn/error-message": "error",
      "unicorn/prefer-type-error": "error",
      "unicorn/no-instanceof-array": "error",
      "unicorn/prefer-number-properties": "error",
      "unicorn/prefer-string-replace-all": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/no-abusive-eslint-disable": "error",
      "unicorn/no-document-cookie": "error",
      "eslint-comments/require-description": "error",
      "eslint-comments/no-unlimited-disable": "error",
      "eslint-comments/no-unused-disable": "error",
      "eslint-comments/disable-enable-pair": "error",
      "eslint-comments/no-restricted-disable": [
        "error",
        "harness/*",
        "no-console",
        "no-eval",
        "no-implied-eval",
        "no-new-func",
        "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-floating-promises",
        "regexp/no-super-linear-backtracking",
        "import-x/no-relative-packages",
        "harness/import-direction",
        "harness/no-relative-packages",
        "no-restricted-imports",
        "no-restricted-properties",
        "no-restricted-globals",
      ],
      "harness/import-direction": "error",
      "harness/no-relative-packages": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            FunctionExpression: true,
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            ClassExpression: true,
          },
          contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration"],
        },
      ],
      "jsdoc/no-types": "error",
      "jsdoc/check-tag-names": [
        "error",
        {
          definedTags: [
            "remarks",
            "example",
            "defaultValue",
            "sealed",
            "inheritDoc",
            "internal",
            "public",
            "virtual",
            "packageDocumentation",
            "typeParam",
            "returns",
            "throws",
            "see",
            "deprecated",
            "param",
            "template",
            "privateRemarks",
            "override",
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx}", "tools/eslint-plugin-harness/src/index.js"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts"],
          defaultProject: "packages/schemas/tsconfig.test.json",
        },
        tsconfigRootDir: rootDirectory,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowNullableBoolean: false,
          allowNullableNumber: false,
          allowNullableString: false,
          allowNumber: false,
          allowString: false,
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],
      "@typescript-eslint/no-restricted-types": [
        "error",
        {
          types: {
            object: { message: "Use a specific object shape." },
            Function: { message: "Use a typed function signature." },
          },
        },
      ],
    },
  },
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    rules: { "import-x/no-default-export": "off" },
  },
  {
    files: ["tools/eslint-plugin-harness/src/index.js"],
    rules: {
      "import-x/no-relative-packages": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "jsdoc/no-types": "off",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,ts,tsx}", "packages/sandbox/**/*.{js,mjs,ts,tsx}"],
    rules: { "no-restricted-imports": restrictedImports({ childProcess: true }) },
  },
  {
    files: ["packages/telemetry/**/*.{js,mjs,ts,tsx}"],
    rules: { "no-restricted-imports": restrictedImports({ telemetry: true }) },
  },
  {
    files: ["packages/schemas/src/parse.ts", "packages/schemas/src/json-schema.ts"],
    rules: { "no-restricted-imports": restrictedImports({ parsers: true }) },
  },
  {
    files: ["packages/schemas/src/parse.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    ignores: [
      "packages/schemas/src/parse.ts",
      "**/*.test.{js,mjs,ts,tsx}",
      "**/*.int.test.{js,mjs,ts,tsx}",
      "**/*.canary.test.{js,mjs,ts,tsx}",
      "**/*.replay.test.{js,mjs,ts,tsx}",
    ],
    rules: { "no-restricted-properties": ["error", ...restrictedProperties] },
  },
  {
    files: [
      "packages/app-telemetry/**/*.{js,mjs,ts,tsx}",
      "packages/approval-app/**/*.{js,mjs,ts,tsx}",
      "packages/host/src/web/**/*.{js,mjs,ts,tsx}",
      "packages/control-plane/app/**/*.{js,mjs,ts,tsx}",
    ],
    rules: {
      "no-restricted-globals": ["error", "process", "require", "Buffer"],
      "no-restricted-imports": browserRestrictedImports(restrictedImports()[1].patterns),
      "no-restricted-properties": ["error", ...restrictedProperties, ...domProperties],
    },
  },
  {
    files: testFiles,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/expect-expect": "error",
      "vitest/no-conditional-expect": "error",
      "vitest/valid-title": "error",
      ...Object.fromEntries([...testRules].map((rule) => [rule, "off"])),
    },
  },
  {
    files: ["scripts/ci/verify-pipeline.test.ts", "scripts/github/apply-branch-protection.test.ts"],
    rules: { "no-restricted-imports": restrictedImports({ childProcess: true, parsers: true }) },
  },
  {
    files: ["scripts/gen-agents-index.test.mjs"],
    rules: { "vitest/no-import-node-test": "off" },
  },
  {
    files: [
      "packages/app-telemetry/**/*.test.{js,mjs,ts,tsx}",
      "packages/approval-app/**/*.test.{js,mjs,ts,tsx}",
      "packages/host/src/web/**/*.test.{js,mjs,ts,tsx}",
      "packages/control-plane/app/**/*.test.{js,mjs,ts,tsx}",
    ],
    rules: { "no-restricted-properties": ["error", ...domProperties] },
  },
  { ...prettier, rules: { ...prettier.rules, curly: ["error", "all"] } },
];

export default errorizeWarnings(configuration);
