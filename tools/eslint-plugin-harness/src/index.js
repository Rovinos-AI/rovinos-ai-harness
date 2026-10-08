// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import layers from "../../../docs/engineering/layers.json" with { type: "json" };

/** @typedef {import("@typescript-eslint/utils/ts-eslint").RuleModule<"forbidden">} HarnessRule */
/** @typedef {import("@typescript-eslint/utils").TSESTree.Node} Node */
/** @typedef {Record<string, readonly string[] | string>} PackageLayers */

/** @type {PackageLayers} */
const packageLayers = layers;
const layerNames = new Set(Object.keys(layers).filter((name) => !name.startsWith("$")));

/** @type {(filename: string) => string | undefined} */
const packageName = (filename) => {
  const segments = filename.split(path.sep);
  const packageIndex = segments.lastIndexOf("packages");
  return packageIndex === -1 ? undefined : segments[packageIndex + 1];
};

/** @type {(node: Node) => string | undefined} */
const importSource = (node) => {
  if (
    node.type === AST_NODE_TYPES.ImportDeclaration ||
    node.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    node.type === AST_NODE_TYPES.ExportAllDeclaration
  ) {
    const value = node.source?.value;
    return typeof value === "string" ? value : undefined;
  }
  if (node.type === AST_NODE_TYPES.ImportExpression) {
    const value = node.source.type === AST_NODE_TYPES.Literal ? node.source.value : undefined;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

/**
 * @type {HarnessRule["create"]}
 * @param {Parameters<HarnessRule["create"]>[0]} context
 * @returns {ReturnType<HarnessRule["create"]>}
 */
const createImportDirection = (context) => {
  const sourcePackage = packageName(context.filename);
  if (sourcePackage === undefined || !layerNames.has(sourcePackage)) {
    return {};
  }

  /** @type {(node: Node) => void} */
  const check = (node) => {
    const source = importSource(node);
    if (typeof source !== "string" || !source.startsWith("@harness/")) {
      return;
    }

    const targetPackage = source.slice("@harness/".length).split("/")[0];
    const sourceDependencies = packageLayers[sourcePackage];
    if (
      targetPackage !== undefined &&
      targetPackage.length > 0 &&
      layerNames.has(targetPackage) &&
      (!Array.isArray(sourceDependencies) || !sourceDependencies.includes(targetPackage))
    ) {
      context.report({
        node,
        messageId: "forbidden",
        data: { source: sourcePackage, target: targetPackage },
      });
    }
  };

  return {
    ImportDeclaration: check,
    ExportNamedDeclaration: check,
    ExportAllDeclaration: check,
    ImportExpression: check,
  };
};

/** @type {HarnessRule} */
const importDirection = {
  meta: {
    type: "problem",
    docs: { description: "enforce the package direction in docs/engineering/layers.json" },
    schema: [],
    messages: {
      forbidden:
        "Package '{{source}}' cannot import '@harness/{{target}}'; update docs/engineering/layers.json if this boundary should change.",
    },
  },
  create: createImportDirection,
};

/**
 * @type {HarnessRule["create"]}
 * @param {Parameters<HarnessRule["create"]>[0]} context
 * @returns {ReturnType<HarnessRule["create"]>}
 */
const createNoRelativePackages = (context) => {
  const sourcePackage = packageName(context.filename);
  if (sourcePackage === undefined || !layerNames.has(sourcePackage)) {
    return {};
  }

  /** @type {(node: Node) => void} */
  const check = (node) => {
    const source = importSource(node);
    if (typeof source !== "string" || !source.startsWith(".")) {
      return;
    }

    const targetPackage = packageName(path.resolve(path.dirname(context.filename), source));
    if (
      targetPackage !== undefined &&
      targetPackage.length > 0 &&
      targetPackage !== sourcePackage &&
      layerNames.has(targetPackage)
    ) {
      context.report({ node, messageId: "forbidden" });
    }
  };

  return {
    ImportDeclaration: check,
    ExportNamedDeclaration: check,
    ExportAllDeclaration: check,
    ImportExpression: check,
  };
};

/** @type {HarnessRule} */
const noRelativePackages = {
  meta: {
    type: "problem",
    docs: { description: "require package names for imports across package boundaries" },
    schema: [],
    messages: {
      forbidden: "Use an '@harness/*' package import instead of a relative cross-package import.",
    },
  },
  create: createNoRelativePackages,
};

export const harnessPlugin = {
  meta: { name: "@harness/eslint-plugin-harness" },
  rules: {
    "import-direction": importDirection,
    "no-relative-packages": noRelativePackages,
  },
};
