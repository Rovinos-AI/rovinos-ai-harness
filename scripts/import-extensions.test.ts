// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

function relativeJsImports(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    }
    if (
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      /^\.\.?\/.*\.js$/u.test(specifier.text)
    ) {
      imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

it("detects relative JavaScript imports without matching comments or other strings", () => {
  const source = `
    import "./static.js";
    export { value } from '../reexport.js';
    const value = import("./dynamic.js");
    type Value = import("./types.js").Value;
    import "./valid.ts";
    import "package/file.js";
    // import "./comment.js";
    const text = 'import "./string.js"';
  `;
  expect(relativeJsImports(source, "example.ts")).toEqual([
    "./static.js",
    "../reexport.js",
    "./dynamic.js",
    "./types.js",
  ]);
});

it("uses TypeScript extensions for relative imports throughout scripts", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const files = globSync("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
    cwd: root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  });
  const violations = files.flatMap((file) =>
    relativeJsImports(readFileSync(new URL(file, import.meta.url), "utf8"), file).map(
      (specifier) => `${file}: ${specifier}`,
    ),
  );
  expect(violations).toEqual([]);
});
