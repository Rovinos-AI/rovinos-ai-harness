// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

it("configures weekly grouped updates and review gates", () => {
  const config: unknown = parse(readFileSync(resolve(root, ".github/dependabot.yml"), "utf8"));

  expect(config).toEqual({
    version: 2,
    updates: [
      {
        "package-ecosystem": "npm",
        directory: "/",
        schedule: { interval: "weekly", day: "monday" },
        "open-pull-requests-limit": 5,
        "commit-message": { prefix: "deps" },
        labels: ["dependencies"],
        groups: {
          "minor-and-patch": { "update-types": ["minor", "patch"] },
        },
        ignore: [
          {
            "dependency-name": "zod",
            "update-types": ["version-update:semver-major"],
          },
          {
            "dependency-name": "@modelcontextprotocol/*",
            "update-types": ["version-update:semver-major"],
          },
          { "dependency-name": "yarn" },
        ],
      },
      {
        "package-ecosystem": "docker",
        directory: "/",
        schedule: { interval: "weekly", day: "monday" },
        "open-pull-requests-limit": 5,
        "commit-message": { prefix: "deps" },
        labels: ["dependencies"],
        groups: {
          "minor-and-patch": { "update-types": ["minor", "patch"] },
        },
      },
    ],
  });
});
