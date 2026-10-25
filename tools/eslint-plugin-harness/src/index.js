// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { noRawTracerRule } from "./rules/no-raw-tracer.ts";

/** @typedef {import("@typescript-eslint/utils/ts-eslint").RuleModule<"forbidden">} HarnessRule */
/** @typedef {import("./rules/no-raw-tracer.ts").NoRawTracerRule} NoRawTracerRule */
/** @typedef {import("@typescript-eslint/utils").TSESTree.Node} Node */
/** @typedef {Record<string, readonly string[] | string>} PackageLayers */

/** Attribute shapes the metrics registry may declare instruments with (closed, reviewed list). */
const allowedMetricAttributeTypes = new Set([
  "NoMetricAttributes",
  "TelemetryDropAttributes",
  "HostAppRejectedAttributes",
  "PolicyDecisionAttributes",
  "ModelUsageAttributes",
  "QuotaRejectionAttributes",
  "WorkerJobAttributes",
  "McpInputRequestAttributes",
]);

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
      if (typeof source !== "string" || !source.startsWith("@rovinos/")) {
        return;
      }

      const targetPackage = source.slice("@rovinos/".length).split("/")[0];
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

/** @type {(node: Node) => string | undefined} */
const identifierName = (node) => (node.type === AST_NODE_TYPES.Identifier ? node.name : undefined);

/**
 * @param {Node} node
 * @param {boolean} computed
 * @returns {string | undefined}
 */
const propertyName = (node, computed) => {
  if (computed && node.type === AST_NODE_TYPES.Literal) {
    return typeof node.value === "string" ? node.value : undefined;
  }
  return identifierName(node);
};

/** @type {(node: Node) => string | undefined} */
const memberPropertyName = (node) =>
  node.type === AST_NODE_TYPES.MemberExpression
    ? propertyName(node.property, node.computed)
    : undefined;

/** @type {HarnessRule["create"]} */
const createSchemaInferredTypes = (context) => {
  const schemaNames = new Set();
  const exportedNames = new Set();
  /** @type {{node: Node, schemaName: string, interfaceName: string}[]} */
  const interfaces = [];

  return {
    VariableDeclaration(node) {
      if (
        node.parent.type !== AST_NODE_TYPES.Program &&
        node.parent.type !== AST_NODE_TYPES.ExportNamedDeclaration
      ) {
        return;
      }
      for (const declarator of node.declarations) {
        if (
          declarator.id.type === AST_NODE_TYPES.Identifier &&
          declarator.id.name.endsWith("Schema")
        ) {
          schemaNames.add(declarator.id.name);
        }
      }
    },
    TSInterfaceDeclaration(node) {
      if (
        node.parent.type === AST_NODE_TYPES.Program ||
        node.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
      ) {
        interfaces.push({
          node,
          schemaName: `${node.id.name}Schema`,
          interfaceName: node.id.name,
        });
      }
    },
    ExportNamedDeclaration(node) {
      const declaration = node.declaration;
      if (declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === AST_NODE_TYPES.Identifier) {
            exportedNames.add(declarator.id.name);
          }
        }
      } else if (declaration?.type === AST_NODE_TYPES.TSInterfaceDeclaration) {
        exportedNames.add(declaration.id.name);
      } else if (declaration === null && node.source === null) {
        for (const specifier of node.specifiers) {
          const localName = identifierName(specifier.local);
          if (localName !== undefined) {
            exportedNames.add(localName);
          }
        }
      }
    },
    "Program:exit"() {
      for (const { node, schemaName, interfaceName } of interfaces) {
        if (
          schemaNames.has(schemaName) &&
          exportedNames.has(schemaName) &&
          exportedNames.has(interfaceName)
        ) {
          context.report({ node, messageId: "forbidden", data: { schema: schemaName } });
        }
      }
    },
  };
};

/** @type {HarnessRule["create"]} */
const createMetricRegistryOnly = (context) => {
  const segments = context.filename.split(path.sep);
  const isRegistry =
    segments.at(-1) === "metrics.ts" &&
    segments.at(-2) === "src" &&
    segments.at(-3) === "telemetry" &&
    segments.at(-4) === "packages";
  const isMetricTest = segments.at(-1) === "metrics.test.ts";
  if (isMetricTest) {
    return {};
  }
  const instrumentFactories = new Set([
    "createCounter",
    "createGauge",
    "createHistogram",
    "createObservableCounter",
    "createObservableGauge",
    "createObservableUpDownCounter",
    "createUpDownCounter",
  ]);
  return {
    CallExpression(node) {
      const property =
        node.callee.type === AST_NODE_TYPES.MemberExpression
          ? memberPropertyName(node.callee)
          : identifierName(node.callee);
      if (typeof property !== "string" || !instrumentFactories.has(property)) {
        return;
      }
      if (!isRegistry) {
        context.report({ node, messageId: "forbidden" });
        return;
      }
      const attributesType = node.typeArguments?.params[0];
      const attributesTypeName =
        attributesType?.type === AST_NODE_TYPES.TSTypeReference
          ? identifierName(attributesType.typeName)
          : undefined;
      if (
        attributesTypeName === undefined ||
        !allowedMetricAttributeTypes.has(attributesTypeName)
      ) {
        context.report({ node, messageId: "forbidden" });
      }
    },
    VariableDeclarator(node) {
      const initializer = node.init;
      const memberName =
        initializer?.type === AST_NODE_TYPES.MemberExpression
          ? memberPropertyName(initializer)
          : undefined;
      const memberFactory = memberName !== undefined && instrumentFactories.has(memberName);
      const destructuredFactory =
        node.id.type === AST_NODE_TYPES.ObjectPattern &&
        node.id.properties.some(
          (property) =>
            property.type === AST_NODE_TYPES.Property &&
            instrumentFactories.has(propertyName(property.key, property.computed) ?? ""),
        );
      if (memberFactory || destructuredFactory) {
        context.report({ node, messageId: "forbidden" });
      }
    },
  };
};

/**
 * Creates the lint rules using the validated package-layer configuration.
 *
 * @param {PackageLayers} packageLayers - The internal package dependency map.
 * @returns {{meta: {name: string}, rules: {"import-direction": HarnessRule, "no-relative-packages": HarnessRule, "schema-inferred-types": HarnessRule, "metric-registry-only": HarnessRule, "no-raw-tracer": NoRawTracerRule}}}
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
          "Package '{{source}}' cannot import '@rovinos/{{target}}'; update docs/engineering/layers.json if this boundary should change.",
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
        forbidden: "Use an '@rovinos/*' package import instead of a relative cross-package import.",
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
  /** @type {HarnessRule} */
  const metricRegistryOnly = {
    meta: {
      type: "problem",
      docs: { description: "centralize metric instruments and writes in the typed registry" },
      schema: [],
      messages: {
        forbidden: "Declare metric instruments only in packages/telemetry/src/metrics.ts.",
      },
    },
    create: createMetricRegistryOnly,
  };

  return {
    meta: { name: "@rovinos/eslint-plugin-harness" },
    rules: {
      "import-direction": importDirection,
      "no-relative-packages": noRelativePackages,
      "schema-inferred-types": schemaInferredTypes,
      "metric-registry-only": metricRegistryOnly,
      "no-raw-tracer": noRawTracerRule,
    },
  };
};
