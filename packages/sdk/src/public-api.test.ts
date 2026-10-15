// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceFiles = ["index.ts", "harness.ts", "types.ts"] as const;
const snapshotUrl = new URL("./__golden__/public-api.d.ts.snap", import.meta.url);

// Edit only AST-selected member spans so unrelated declaration text stays exact.
function sortedMemberReplacement<Member extends ts.Node>(
  source: ts.SourceFile,
  members: readonly Member[],
  memberKey: (member: Member) => string,
): { readonly start: number; readonly end: number; readonly text: string } | undefined {
  if (members.length < 2) {
    return undefined;
  }
  const original = members.map((node) => ({
    node,
    key: memberKey(node),
    text: node.getText(source),
  }));
  const sorted = [...original].sort((left, right) => {
    if (left.key < right.key) {
      return -1;
    }
    if (left.key > right.key) {
      return 1;
    }
    return 0;
  });
  if (sorted.every((member, index) => member.node === original[index]?.node)) {
    return undefined;
  }
  const separators = members.slice(0, -1).map((member, index) => {
    const next = members[index + 1];
    if (next === undefined) {
      throw new Error("Declaration member separator is missing.");
    }
    return source.text.slice(member.getEnd(), next.getStart(source));
  });
  return {
    start: members[0]?.getStart(source) ?? 0,
    end: members.at(-1)?.getEnd() ?? 0,
    text: sorted.map((member, index) => `${member.text}${separators[index] ?? ""}`).join(""),
  };
}

function isStringLiteralTypeNode(
  member: ts.TypeNode,
): member is ts.LiteralTypeNode & { readonly literal: ts.StringLiteralLike } {
  return ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal);
}

function normalizeDeclarationText(declaration: string): string {
  const source = ts.createSourceFile(
    "public-api.d.ts",
    declaration,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const replacements: {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node) && node.types.every(isStringLiteralTypeNode)) {
      const replacement = sortedMemberReplacement(
        source,
        node.types,
        (member) => member.literal.text,
      );
      if (replacement !== undefined) {
        replacements.push(replacement);
      }
    } else if (
      ts.isTypeReferenceNode(node) &&
      ts.isQualifiedName(node.typeName) &&
      ts.isIdentifier(node.typeName.left) &&
      node.typeName.left.text === "z" &&
      node.typeName.right.text === "ZodEnum"
    ) {
      const enumMembers = node.typeArguments?.[0];
      if (
        enumMembers !== undefined &&
        ts.isTypeLiteralNode(enumMembers) &&
        enumMembers.members.every(ts.isPropertySignature)
      ) {
        const replacement = sortedMemberReplacement(source, enumMembers.members, (member) =>
          member.name.getText(source),
        );
        if (replacement !== undefined) {
          replacements.push(replacement);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (text, replacement) =>
        `${text.slice(0, replacement.start)}${replacement.text}${text.slice(replacement.end)}`,
      declaration,
    );
}

function publicDeclarations(): string {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const configFile = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    {},
    configPath,
  );
  if (config.errors.length > 0) {
    throw new Error("SDK TypeScript configuration could not be loaded.");
  }
  const options: ts.CompilerOptions = {
    ...config.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
  };
  const rootNames = sourceFiles.map((file) => fileURLToPath(new URL(`./${file}`, import.meta.url)));
  const program = ts.createProgram({ rootNames, options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  const output = new Map<string, string>();
  const result = program.emit(
    undefined,
    (fileName, text) => output.set(basename(fileName), text.trim()),
    undefined,
    true,
  );
  expect(result.emitSkipped).toBe(false);
  return `// SPDX-License-Identifier: Apache-2.0\n${sourceFiles
    .map((file) => {
      const declaration = output.get(file.replace(".ts", ".d.ts"));
      if (declaration === undefined) {
        throw new Error("SDK declaration output is incomplete.");
      }
      return declaration;
    })
    .join("\n\n")}\n`;
}

describe("public SDK declaration snapshot", () => {
  it("matches the committed declaration surface", async () => {
    const actual = normalizeDeclarationText(publicDeclarations());
    if (process.env.UPDATE_GOLDEN === "1") {
      await writeFile(snapshotUrl, actual);
    }
    expect(actual).toBe(await readFile(snapshotUrl, "utf8"));
  }, 60_000);
});

describe("public declaration normalization", () => {
  it("ignores ZodEnum and string-literal union member order", () => {
    const first = [
      'type Decision = z.ZodEnum<{ approve: "approve"; deny: "deny"; }>; ',
      'type Action = "approve" | "deny";',
    ].join("");
    const reordered = [
      'type Decision = z.ZodEnum<{ deny: "deny"; approve: "approve"; }>; ',
      'type Action = "deny" | "approve";',
    ].join("");

    expect(normalizeDeclarationText(first)).toBe(normalizeDeclarationText(reordered));
  });

  it.each([
    [
      "a removed enum member",
      'type Decision = z.ZodEnum<{ approve: "approve"; deny: "deny"; }>; ',
      'type Decision = z.ZodEnum<{ approve: "approve"; }>; ',
    ],
    [
      "a renamed enum member",
      'type Decision = z.ZodEnum<{ approve: "approve"; deny: "deny"; }>; ',
      'type Decision = z.ZodEnum<{ approve: "approve"; reject: "reject"; }>; ',
    ],
    ["a removed union member", 'type Action = "approve" | "deny";', 'type Action = "approve";'],
    [
      "a renamed union member",
      'type Action = "approve" | "deny";',
      'type Action = "approve" | "reject";',
    ],
  ])("preserves API changes such as %s", (_change, original, changed) => {
    expect(normalizeDeclarationText(original)).not.toBe(normalizeDeclarationText(changed));
  });

  it("preserves object property order", () => {
    const first = "type Options = { approve: string; deny: string; };";
    const reordered = "type Options = { deny: string; approve: string; };";

    expect(normalizeDeclarationText(first)).not.toBe(normalizeDeclarationText(reordered));
  });
});
