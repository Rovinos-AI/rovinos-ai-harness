// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";

/** @typedef {import("@typescript-eslint/utils/ts-eslint").RuleModule<"forbidden">} HarnessRule */
/** @typedef {import("@typescript-eslint/utils").TSESTree.Node} Node */
/** @typedef {Record<string, readonly string[] | string>} PackageLayers */

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
 * @param {PackageLayers} packageLayers
 * @param {Set<string>} layerNames
 * @returns {HarnessRule["create"]}
 */
const createImportDirection = (packageLayers, layerNames) => {
  /** @type {HarnessRule["create"]} */
  const create = (context) => {
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
  return create;
};

/**
 * @param {Set<string>} layerNames
 * @returns {HarnessRule["create"]}
 */
const createNoRelativePackages = (layerNames) => {
  /** @type {HarnessRule["create"]} */
  const create = (context) => {
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
  return create;
};

/** @type {HarnessRule["create"]} */
const createSchemaInferredTypes = (context) => {
  const schemaNames = new Set();
  /** @type {{node: Node, schemaName: string}[]} */
  const interfaces = [];

  return {
    ExportNamedDeclaration(node) {
      const declaration = node.declaration;
      if (declaration === null) {
        return;
      }
      if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
        for (const declarator of declaration.declarations) {
          if (
            declarator.id.type === AST_NODE_TYPES.Identifier &&
            declarator.id.name.endsWith("Schema")
          ) {
            schemaNames.add(declarator.id.name);
          }
        }
      } else if (declaration.type === AST_NODE_TYPES.TSInterfaceDeclaration) {
        interfaces.push({ node: declaration, schemaName: `${declaration.id.name}Schema` });
      }
    },
    "Program:exit"() {
      for (const { node, schemaName } of interfaces) {
        if (schemaNames.has(schemaName)) {
          context.report({ node, messageId: "forbidden", data: { schema: schemaName } });
        }
      }
    },
  };
};

/**
 * Creates the lint rules using the validated package-layer configuration.
 *
 * @param {PackageLayers} packageLayers - The internal package dependency map.
 * @returns {{meta: {name: string}, rules: {"import-direction": HarnessRule, "no-relative-packages": HarnessRule, "schema-inferred-types": HarnessRule}}}
 */
export const createHarnessPlugin = (packageLayers) => {
  const layerNames = new Set(Object.keys(packageLayers).filter((name) => !name.startsWith("$")));
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
    create: createImportDirection(packageLayers, layerNames),
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
    create: createNoRelativePackages(layerNames),
  };
  /** @type {HarnessRule} */
  const schemaInferredTypes = {
    meta: {
      type: "problem",
      docs: { description: "require schema-inferred contract types" },
      schema: [],
      messages: {
        forbidden: "Use z.infer<typeof {{schema}}> instead of a hand-written interface.",
      },
    },
    create: createSchemaInferredTypes,
  };

  return {
    meta: { name: "@harness/eslint-plugin-harness" },
    rules: {
      "import-direction": importDirection,
      "no-relative-packages": noRelativePackages,
      "schema-inferred-types": schemaInferredTypes,
    },
  };
};
