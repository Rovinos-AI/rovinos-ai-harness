// SPDX-License-Identifier: Apache-2.0
import yml from "eslint-plugin-yml";

export const yamlLintConfiguration = [
  ...yml.configs["flat/recommended"],
  {
    files: ["**/*.{yaml,yml}"],
    rules: { "yml/indent": ["error", 2], "yml/no-tab-indent": "error" },
  },
];
