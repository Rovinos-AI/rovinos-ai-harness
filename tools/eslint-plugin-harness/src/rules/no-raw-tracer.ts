// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
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

function hasSpanReceiver(node: TSESTree.Node): boolean {
  const current = unwrapChain(node);
  if (current.type === AST_NODE_TYPES.Identifier) {
    return current.name.toLowerCase().includes("span");
  }
  if (current.type === AST_NODE_TYPES.MemberExpression) {
    return (
      memberName(current)?.toLowerCase().includes("span") === true ||
      hasSpanReceiver(current.object)
    );
  }
  if (
    current.type === AST_NODE_TYPES.CallExpression &&
    memberName(unwrapChain(current.callee)) === "getActiveSpan"
  ) {
    return true;
  }
  return false;
}

function matchesAllowedFile(filename: string, patterns: readonly string[]): boolean {
  const relativeFilename = path.relative(process.cwd(), filename).split(path.sep).join("/");
  return patterns.some((pattern) => path.matchesGlob(relativeFilename, pattern));
}

/** Creates ESLint listeners that enforce registered span APIs. */
const createNoRawTracerRule: NoRawTracerRule["create"] = (context) => {
  const configuredFiles = context.options[0]?.allowedFiles;
  const allowedFiles = configuredFiles ?? defaultAllowedFiles;
  if (matchesAllowedFile(context.filename, allowedFiles)) {
    return {};
  }

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
        (name !== undefined && spanAttributeMethods.has(name) && hasSpanReceiver(callee.object))
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
        "Use defineSpan(...).start(...) or withSpan(...) from @harness/telemetry instead of raw OpenTelemetry span APIs.",
    },
  },
  create: createNoRawTracerRule,
};
