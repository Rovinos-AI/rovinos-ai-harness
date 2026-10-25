// SPDX-License-Identifier: Apache-2.0
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const rootManifest = require("./package.json");
const miseConfig = readFileSync(join(__dirname, "mise.toml"), "utf8");
const nodeVersion = /^node\s*=\s*"([^"]+)"$/m.exec(miseConfig)?.[1];
const nodeTypesRange = rootManifest.devDependencies["@types/node"];
const publishedWorkspaceIdents = new Set([
  "@rovinos/cli",
  "@rovinos/sdk",
  "@rovinos/store-postgres",
  "@rovinos/store-sqlite",
]);

module.exports = {
  async constraints({ Yarn }) {
    const workspaces = Yarn.workspaces();
    const workspaceIdents = new Set(workspaces.map((workspace) => workspace.ident));
    const rootWorkspace = workspaces.find((workspace) => workspace.ident === rootManifest.name);
    const nodeVersionMatch = /^(\d+)\.\d+\.\d+$/.exec(nodeVersion ?? "");
    const nodeTypesMatch = /^(\d+)\.\d+\.\d+$/.exec(nodeTypesRange);

    if (nodeVersionMatch === null || nodeTypesMatch === null) {
      rootWorkspace?.error("The mise Node and @types/node pins must be exact semantic versions.");
    } else if (nodeVersionMatch[1] !== nodeTypesMatch[1]) {
      rootWorkspace?.error(
        `The @types/node major must match the Node major pinned in mise.toml (${nodeVersionMatch[1]}).`,
      );
    }

    for (const workspace of workspaces) {
      workspace.set("type", "module");
      workspace.set("license", "Apache-2.0");
      if (!publishedWorkspaceIdents.has(workspace.ident)) {
        workspace.set("private", true);
      }
    }

    for (const dependency of Yarn.dependencies()) {
      if (
        dependency.type === "peerDependencies" ||
        dependency.ident === "better-sqlite3" ||
        dependency.ident === "pg"
      ) {
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
