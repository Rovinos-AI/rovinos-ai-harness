// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";

const composeFile = "infra/compose/docker-compose.test.yml";

/** Returns the healthcheck status of the Compose harness service. */
export function readHarnessHealthStatus(): string {
  const containerId = execFileSync(
    "docker",
    ["compose", "-f", composeFile, "ps", "--quiet", "harness"],
    { encoding: "utf8" },
  ).trim();

  if (containerId === "") {
    throw new Error("harness service is not running; start it with scripts/ci/compose-wait.sh");
  }

  return execFileSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", containerId], {
    encoding: "utf8",
  }).trim();
}
