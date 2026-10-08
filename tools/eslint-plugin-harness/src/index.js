// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import layers from "../../../docs/engineering/layers.json" with { type: "json" };

const layerNames = new Set(Object.keys(layers).filter((name) => !name.startsWith("$")));

function packageName(filename) {
  const segments = filename.split(path.sep);
  const packageIndex = segments.lastIndexOf("packages");
  return packageIndex === -1 ? undefined : segments[packageIndex + 1];
}

function importSource(node) {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration"
  ) {
    return node.source?.value;
  }
  if (node.type === "ImportExpression") {
    return node.source.type === "Literal" ? node.source.value : undefined;
  }
  return undefined;
}

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
  create(context) {
    const sourcePackage = packageName(context.filename);
    if (!sourcePackage || !layerNames.has(sourcePackage)) {
      return {};
    }

    function check(node) {
      const source = importSource(node);
      if (typeof source !== "string" || !source.startsWith("@harness/")) {
        return;
      }

      const targetPackage = source.slice("@harness/".length).split("/")[0];
      if (
        targetPackage &&
        layerNames.has(targetPackage) &&
        !(layers[sourcePackage] ?? []).includes(targetPackage)
      ) {
        context.report({
          node,
          messageId: "forbidden",
          data: { source: sourcePackage, target: targetPackage },
        });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

const noRelativePackages = {
  meta: {
    type: "problem",
    docs: { description: "require package names for imports across package boundaries" },
    schema: [],
    messages: {
      forbidden: "Use an '@harness/*' package import instead of a relative cross-package import.",
    },
  },
  create(context) {
    const sourcePackage = packageName(context.filename);
    if (!sourcePackage || !layerNames.has(sourcePackage)) {
      return {};
    }

    function check(node) {
      const source = importSource(node);
      if (typeof source !== "string" || !source.startsWith(".")) {
        return;
      }

      const targetPackage = packageName(path.resolve(path.dirname(context.filename), source));
      if (targetPackage && targetPackage !== sourcePackage && layerNames.has(targetPackage)) {
        context.report({ node, messageId: "forbidden" });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export const harnessPlugin = {
  meta: { name: "@harness/eslint-plugin-harness" },
  rules: {
    "import-direction": importDirection,
    "no-relative-packages": noRelativePackages,
  },
};
