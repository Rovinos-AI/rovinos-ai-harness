// SPDX-License-Identifier: Apache-2.0
import type { RuleModule } from "@typescript-eslint/utils/ts-eslint";

export declare const harnessPlugin: {
  readonly meta: { readonly name: string };
  readonly rules: {
    readonly "import-direction": RuleModule<"forbidden">;
    readonly "no-relative-packages": RuleModule<"forbidden">;
  };
};
