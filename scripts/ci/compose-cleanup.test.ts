// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { cleanupStaleComposeProjects } from "./compose-cleanup.js";

it("removes only known stale projects and keeps current or recently started stacks", () => {
  const commands: string[][] = [];
  const projects = [
    { Name: "compose", Status: "exited(2)" },
    { Name: "harness-local-1", Status: "exited(2)" },
    { Name: "harness-ci-41", Status: "exited(2)" },
    { Name: "harness-ci-42", Status: "running(1)" },
    { Name: "harness-ci-43", Status: "running(1)" },
    { Name: "harness-ci-44", Status: "running(1)" },
    { Name: "local-integration", Status: "exited(1)" },
  ];
  const containerIdsByProject: Record<string, string[]> = {
    compose: ["compose-exited"],
    "harness-local-1": ["local-exited"],
    "harness-ci-41": ["exited"],
    "harness-ci-42": ["recent"],
    "harness-ci-43": ["old"],
    "harness-ci-44": ["current"],
  };
  const startedAtByContainer: Record<string, string> = {
    "compose-exited": "2026-10-21T16:03:30.631Z",
    "local-exited": "2026-10-21T12:13:30.631Z",
    exited: "2026-10-21T12:13:30.631Z",
    recent: "2026-10-21T16:03:30.631Z",
    old: "2026-10-21T12:13:30.631Z",
    current: "2026-10-21T12:13:30.631Z",
  };
  const stateByContainer: Record<string, string> = {
    "compose-exited": "exited",
    "local-exited": "exited",
    exited: "exited",
    recent: "running",
    old: "running",
    current: "running",
  };
  const now = Date.parse("2026-10-21T16:13:30.631Z");

  cleanupStaleComposeProjects(
    "harness-ci-44",
    (args) => {
      commands.push([...args]);
      if (args[0] === "compose") {
        return JSON.stringify(projects);
      }
      if (args[0] === "ps") {
        const project = args[3]?.replace("label=com.docker.compose.project=", "");
        return (containerIdsByProject[project ?? ""] ?? [])
          .map((ID) => JSON.stringify({ ID }))
          .join("\n");
      }
      if (args[0] === "inspect") {
        return JSON.stringify(
          args.slice(1).map((ID) => ({
            State: { Status: stateByContainer[ID], StartedAt: startedAtByContainer[ID] },
          })),
        );
      }
      return "";
    },
    { now: () => now },
  );

  const downProjects = commands
    .filter((args) => args[0] === "compose" && args.includes("down"))
    .map((args) => args[2]);
  expect(downProjects).toEqual(["compose", "harness-local-1", "harness-ci-41", "harness-ci-43"]);
  expect(commands).not.toContainEqual([
    "ps",
    "--all",
    "--filter",
    "label=com.docker.compose.project=local-integration",
    "--format",
    "json",
  ]);
});
