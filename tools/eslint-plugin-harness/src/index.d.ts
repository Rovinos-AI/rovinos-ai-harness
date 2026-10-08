// SPDX-License-Identifier: Apache-2.0
import type { Rule } from "eslint";

export declare const harnessPlugin: {
  readonly meta: { readonly name: string };
  readonly rules: {
    readonly "import-direction": Rule.RuleModule;
    readonly "no-relative-packages": Rule.RuleModule;
  };
};
