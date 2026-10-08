// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { parseYaml } from "@harness/schemas";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const updateSchema = z.discriminatedUnion("package-ecosystem", [
  z
    .object({
      "package-ecosystem": z.literal("npm"),
      directory: z.string(),
      schedule: z.object({ interval: z.literal("weekly"), day: z.literal("monday") }).strict(),
      "open-pull-requests-limit": z.number(),
      cooldown: z.object({ "default-days": z.number() }).strict(),
      "commit-message": z.object({ prefix: z.string() }).strict(),
      groups: z.record(
        z.string(),
        z.object({ "update-types": z.array(z.enum(["minor", "patch"])) }).strict(),
      ),
      ignore: z.array(
        z
          .object({
            "dependency-name": z.string(),
            "update-types": z.array(z.string()).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      "package-ecosystem": z.literal("docker"),
      directory: z.string(),
      schedule: z.object({ interval: z.literal("weekly"), day: z.literal("monday") }).strict(),
      "open-pull-requests-limit": z.number(),
      "commit-message": z.object({ prefix: z.string() }).strict(),
      groups: z.record(
        z.string(),
        z.object({ "update-types": z.array(z.enum(["minor", "patch"])) }).strict(),
      ),
      ignore: z.array(
        z
          .object({
            "dependency-name": z.string(),
            "update-types": z.array(z.string()).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
const dependabotSchema = z
  .object({
    version: z.literal(2),
    updates: z.array(updateSchema),
  })
  .strict();
const yarnConfigSchema = z
  .object({
    nodeLinker: z.literal("node-modules"),
    enableTelemetry: z.boolean(),
    enableGlobalCache: z.boolean(),
    defaultSemverRangePrefix: z.literal(""),
    npmMinimalAgeGate: z
      .string()
      .regex(/^\d+d$/u)
      .transform((value) => Number(value.slice(0, -1))),
    npmPreapprovedPackages: z.array(z.string()),
    enableScripts: z.boolean(),
  })
  .strict();

it("configures weekly grouped updates and review gates", () => {
  const config = parseYaml(
    dependabotSchema,
    readFileSync(resolve(root, ".github/dependabot.yml"), "utf8"),
  );
  const yarnConfig = parseYaml(
    yarnConfigSchema,
    readFileSync(resolve(root, ".yarnrc.yml"), "utf8"),
  );

  expect(config).toEqual({
    version: 2,
    updates: [
      {
        "package-ecosystem": "npm",
        directory: "/",
        schedule: { interval: "weekly", day: "monday" },
        "open-pull-requests-limit": 5,
        cooldown: { "default-days": yarnConfig.npmMinimalAgeGate },
        "commit-message": { prefix: "deps" },
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
        groups: {
          "minor-and-patch": { "update-types": ["minor", "patch"] },
        },
        ignore: [
          {
            "dependency-name": "node",
            "update-types": ["version-update:semver-major"],
          },
          { "dependency-name": "ghcr.io/jdx/mise" },
        ],
      },
    ],
  });
});
