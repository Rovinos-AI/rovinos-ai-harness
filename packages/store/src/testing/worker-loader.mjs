// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

/** Compiles test worker TypeScript modules as ESM. */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    return { format: "module", shortCircuit: true, source: output.outputText };
  }
  return nextLoad(url, context);
}
