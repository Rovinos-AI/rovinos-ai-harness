// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import type { RuleModule } from "@typescript-eslint/utils/ts-eslint";

const defaultAllowedFiles = [
  "packages/telemetry/src/registry.ts",
  "packages/telemetry/src/log-registry.ts",
  "packages/telemetry/src/tracer.ts",
  "packages/telemetry/src/sdk.ts",
  "packages/telemetry/src/testing.ts",
  "**/*.test.ts",
  "test/canary/telemetry.ts",
  "test/fixtures/sample-mcp-server/server.ts",
  "test/mcp-servers.int-client.test.mjs",
];

const forbiddenMethods = new Set(["startSpan", "startActiveSpan", "recordException", "updateName"]);
const spanAttributeMethods = new Set(["setAttribute", "setAttributes"]);
const spanProducingMethods = new Set([
  "getSpan",
  "getActiveSpan",
  "start",
  "startSpan",
  "startActiveSpan",
]);

interface NoRawTracerOptions {
  allowedFiles?: string[];
}

/** ESLint rule module type for the configurable raw-tracer allowlist. */
export type NoRawTracerRule = RuleModule<"forbidden", [NoRawTracerOptions?]>;

function unwrapChain(node: TSESTree.Node): TSESTree.Node {
  return node.type === AST_NODE_TYPES.ChainExpression ? node.expression : node;
}

function memberName(node: TSESTree.Node): string | undefined {
  if (node.type !== AST_NODE_TYPES.MemberExpression) {
    return undefined;
  }
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : undefined;
  }
  return undefined;
}

function staticString(node: TSESTree.Node | null | undefined): string | undefined {
  if (node?.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function isSdkImport(source: string): boolean {
  return (
    source === "@opentelemetry/sdk" ||
    source.startsWith("@opentelemetry/sdk-") ||
    source.startsWith("@opentelemetry/sdk/")
  );
}

function hasSpanTypeAnnotation(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name === "Span";
  }
  if (node.type === AST_NODE_TYPES.TSQualifiedName) {
    return node.right.name === "Span";
  }
  if (node.type === AST_NODE_TYPES.TSTypeReference) {
    return hasSpanTypeAnnotation(node.typeName);
  }
  if (node.type === AST_NODE_TYPES.TSUnionType || node.type === AST_NODE_TYPES.TSIntersectionType) {
    return node.types.some(hasSpanTypeAnnotation);
  }
  return false;
}

function findVariable(
  scope: TSESLint.Scope.Scope | null,
  name: string,
): TSESLint.Scope.Variable | undefined {
  let current = scope;
  while (current !== null) {
    const variable = current.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
    current = current.upper;
  }
  return undefined;
}

function isSpanExpression(
  node: TSESTree.Node,
  sourceCode: TSESLint.SourceCode,
  visited: Set<TSESLint.Scope.Variable> = new Set<TSESLint.Scope.Variable>(),
): boolean {
  const current = unwrapChain(node);
  if (current.type === AST_NODE_TYPES.Identifier) {
    const variable = findVariable(sourceCode.getScope(current), current.name);
    if (variable === undefined || visited.has(variable)) {
      return false;
    }
    visited.add(variable);
    if (
      variable.identifiers.some(
        (identifier) =>
          identifier.typeAnnotation !== undefined &&
          hasSpanTypeAnnotation(identifier.typeAnnotation.typeAnnotation),
      )
    ) {
      return true;
    }
    return (
      variable.defs.some(
        (definition) =>
          definition.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init !== null &&
          isSpanExpression(definition.node.init, sourceCode, visited),
      ) ||
      variable.references.some(
        (reference) =>
          reference.isWrite() &&
          reference.writeExpr !== null &&
          reference.writeExpr !== undefined &&
          isSpanExpression(reference.writeExpr, sourceCode, visited),
      )
    );
  }
  if (current.type === AST_NODE_TYPES.CallExpression) {
    const callee = unwrapChain(current.callee);
    return (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      spanProducingMethods.has(memberName(callee) ?? "")
    );
  }
  if (current.type === AST_NODE_TYPES.MemberExpression) {
    return isSpanExpression(current.object, sourceCode, visited);
  }
  return false;
}

function matchesAllowedFile(filename: string, patterns: readonly string[], cwd: string): boolean {
  const relativeFilename = path.relative(cwd, filename).split(path.sep).join("/");
  return patterns.some((pattern) => path.matchesGlob(relativeFilename, pattern));
}

/** Creates ESLint listeners that enforce registered span APIs. */
const createNoRawTracerRule: NoRawTracerRule["create"] = (context) => {
  const configuredFiles = context.options[0]?.allowedFiles;
  const allowedFiles = configuredFiles ?? defaultAllowedFiles;
  const cwd = context.cwd !== "" ? context.cwd : process.cwd();
  if (matchesAllowedFile(context.filename, allowedFiles, cwd)) {
    return {};
  }
  const sourceCode = context.sourceCode;

  const checkImport = (node: TSESTree.Node): void => {
    let source: string | undefined;
    if (
      node.type === AST_NODE_TYPES.ImportDeclaration ||
      node.type === AST_NODE_TYPES.ExportNamedDeclaration ||
      node.type === AST_NODE_TYPES.ExportAllDeclaration
    ) {
      if (
        (node.type === AST_NODE_TYPES.ImportDeclaration && node.importKind === "type") ||
        (node.type === AST_NODE_TYPES.ExportNamedDeclaration && node.exportKind === "type")
      ) {
        return;
      }
      source = staticString(node.source);
    } else if (node.type === AST_NODE_TYPES.ImportExpression) {
      source = staticString(node.source);
    }
    if (source !== undefined && isSdkImport(source)) {
      context.report({ node, messageId: "forbidden" });
    }
  };

  return {
    ImportDeclaration: checkImport,
    ExportNamedDeclaration: checkImport,
    ExportAllDeclaration: checkImport,
    ImportExpression: checkImport,
    CallExpression(node) {
      const callee = unwrapChain(node.callee);
      if (callee.type !== AST_NODE_TYPES.MemberExpression) {
        if (
          callee.type === AST_NODE_TYPES.Identifier &&
          callee.name === "require" &&
          isSdkImport(staticString(node.arguments[0]) ?? "")
        ) {
          context.report({ node, messageId: "forbidden" });
        }
        return;
      }

      const name = memberName(callee);
      if (
        (name !== undefined && forbiddenMethods.has(name)) ||
        (name !== undefined &&
          spanAttributeMethods.has(name) &&
          isSpanExpression(callee.object, sourceCode))
      ) {
        context.report({ node, messageId: "forbidden" });
      }
    },
    MemberExpression(node) {
      if (memberName(node) === "getTracer") {
        context.report({ node, messageId: "forbidden" });
      }
    },
  };
};

/** Forbid raw OpenTelemetry span creation and mutation outside the telemetry registry. */
export const noRawTracerRule: NoRawTracerRule = {
  meta: {
    type: "problem",
    docs: { description: "require registered span definitions for OpenTelemetry spans" },
    schema: [
      {
        type: "object",
        properties: {
          allowedFiles: { type: "array", items: { type: "string" }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "Use defineSpan(...).start(...) or withSpan(...) from @rovinos/telemetry instead of raw OpenTelemetry span APIs.",
    },
  },
  create: createNoRawTracerRule,
};
