// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const composeProjectsSchema = z.array(z.looseObject({ Name: z.string() }));
const composeFile = "infra/compose/docker-compose.test.yml";
const envFile = "infra/collector/VERSION";

type ComposeRunner = (args: readonly string[]) => string;

/** Removes abandoned CI Compose projects while leaving the current build and unrelated projects alone. */
export function cleanupStaleComposeProjects(
  currentProjectName: string,
  runCompose: ComposeRunner = (args) =>
    execFileSync("docker", [...args], { cwd: root, encoding: "utf8" }),
): void {
  const projects = parseJson(
    composeProjectsSchema,
    runCompose(["compose", "ls", "--all", "--format", "json"]),
  );
  for (const { Name } of projects) {
    if (!Name.startsWith("harness-ci-") || Name === currentProjectName) {
      continue;
    }
    runCompose([
      "compose",
      "--project-name",
      Name,
      "--env-file",
      envFile,
      "--file",
      composeFile,
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const currentProjectName = process.env.COMPOSE_PROJECT_NAME;
  if (currentProjectName?.startsWith("harness-ci-") !== true) {
    throw new Error("COMPOSE_PROJECT_NAME must identify the current harness-ci build.");
  }
  cleanupStaleComposeProjects(currentProjectName);
}
