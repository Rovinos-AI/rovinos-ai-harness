// SPDX-License-Identifier: Apache-2.0
const rootManifest = require("./package.json");
const nodeMajor = Number.parseInt(rootManifest.engines.node.match(/\d+/)?.[0] ?? "", 10);
const nodeTypesRange = rootManifest.devDependencies["@types/node"];
const nodeTypesMajor = Number.parseInt(nodeTypesRange.match(/^\d+/)?.[0] ?? "", 10);

if (nodeMajor !== nodeTypesMajor) {
  throw new Error("The @types/node major must match the Node major.");
}

module.exports = {
  async constraints({ Yarn }) {
    const workspaces = Yarn.workspaces();
    const workspaceIdents = new Set(workspaces.map((workspace) => workspace.ident));

    for (const workspace of workspaces) {
      workspace.set("type", "module");
      workspace.set("license", "Apache-2.0");
      workspace.set("private", true);
    }

    for (const dependency of Yarn.dependencies()) {
      if (dependency.type === "peerDependencies") {
        continue;
      }

      if (workspaceIdents.has(dependency.ident)) {
        dependency.update("workspace:^");
      }

      for (const otherDependency of Yarn.dependencies({ ident: dependency.ident })) {
        if (otherDependency.type !== "peerDependencies") {
          dependency.update(otherDependency.range);
        }
      }

      if (dependency.ident === "@types/node") {
        dependency.update(nodeTypesRange);
      }
    }
  },
};
