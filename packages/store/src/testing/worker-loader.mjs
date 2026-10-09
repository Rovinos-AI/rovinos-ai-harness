// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolves source imports that use emitted `.js` extensions to their TypeScript files. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const sourceUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    const compiledUrl = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(compiledUrl)) && existsSync(fileURLToPath(sourceUrl))) {
      return nextResolve(sourceUrl.href, context);
    }
  }
  return nextResolve(specifier, context);
}
