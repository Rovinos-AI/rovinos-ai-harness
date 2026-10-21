// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const composeProjectsSchema = z.array(z.looseObject({ Name: z.string() }));
const runningContainerSchema = z.looseObject({ ID: z.string() });
const containerStatesSchema = z.array(
  z.looseObject({
    State: z.looseObject({ Status: z.string(), StartedAt: z.string() }),
  }),
);
const composeFile = "infra/compose/docker-compose.test.yml";
const envFile = "infra/collector/VERSION";
// Three hours is three times the integration job's explicit 60-minute timeout.
const staleAfterMs = 3 * 60 * 60 * 1000;

type ComposeRunner = (args: readonly string[]) => string;
interface Clock {
  now(): number;
}

/** Removes stale known Compose projects while preserving the current build and unrelated projects. */
export function cleanupStaleComposeProjects(
  currentProjectName: string,
  runCompose: ComposeRunner = (args) =>
    execFileSync("docker", [...args], { cwd: root, encoding: "utf8" }),
  clock: Clock = { now: () => Date.now() },
): void {
  const projects = parseJson(
    composeProjectsSchema,
    runCompose(["compose", "ls", "--all", "--format", "json"]),
  );
  for (const { Name } of projects) {
    if (
      (Name !== "compose" &&
        !Name.startsWith("harness-local-") &&
        !Name.startsWith("harness-ci-")) ||
      Name === currentProjectName
    ) {
      continue;
    }
    const containers = runCompose([
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${Name}`,
      "--format",
      "json",
    ])
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => parseJson(runningContainerSchema, line));
    if (containers.length > 0) {
      const states = parseJson(
        containerStatesSchema,
        runCompose(["inspect", ...containers.map(({ ID }) => ID)]),
      );
      if (states.some(({ State }) => State.Status === "running")) {
        const startedAtValues = states.map(({ State }) => Date.parse(State.StartedAt));
        if (
          startedAtValues.some((startedAt) => !Number.isFinite(startedAt)) ||
          clock.now() - Math.max(...startedAtValues) <= staleAfterMs
        ) {
          continue;
        }
      }
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
