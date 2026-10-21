// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { cleanupStaleComposeProjects } from "./compose-cleanup.js";

it("removes only stale harness-ci projects", () => {
  const commands: string[][] = [];
  const projects = [
    { Name: "harness-ci-41", Status: "running(3)" },
    { Name: "harness-ci-42", Status: "running(3)" },
    { Name: "compose", Status: "running(2)" },
    { Name: "local-integration", Status: "exited(1)" },
  ];

  cleanupStaleComposeProjects("harness-ci-42", (args) => {
    commands.push([...args]);
    return commands.length === 1 ? JSON.stringify(projects) : "";
  });

  expect(commands).toEqual([
    ["compose", "ls", "--all", "--format", "json"],
    [
      "compose",
      "--project-name",
      "harness-ci-41",
      "--env-file",
      "infra/collector/VERSION",
      "--file",
      "infra/compose/docker-compose.test.yml",
      "down",
      "--volumes",
      "--remove-orphans",
    ],
  ]);
});
