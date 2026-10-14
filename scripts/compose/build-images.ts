// SPDX-License-Identifier: Apache-2.0
// Builds the Compose images used by integration suites once, before any suite starts. The suites
// then run `up` without `--build`: parallel builds of the same tags on one Docker daemon race
// ("image already exists") and fail cold builds, which made the sandbox and prod-like suites flaky.
import { spawnSync } from "node:child_process";

const BUILD_TIMEOUT_MS = 15 * 60_000;

/** Vitest global setup: builds `harness:local` and `harness-sandbox:local` when Docker is up. */
export function setup(): void {
  if (process.env.HARNESS_SKIP_COMPOSE_BUILD === "1") {
    return;
  }
  const dockerAvailable =
    spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0;
  if (!dockerAvailable) {
    return;
  }
  const build = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--profile",
      "sandbox",
      "--profile",
      "sandbox-egress",
      "--file",
      "infra/compose/docker-compose.yml",
      "build",
      // sandbox-runner and sandbox-egress-proxy share the harness-sandbox:local tag; building both
      // services would build that image twice in parallel and race. One service per image.
      "harness",
      "sandbox-runner",
    ],
    { stdio: "inherit", timeout: BUILD_TIMEOUT_MS },
  );
  if (build.status !== 0) {
    throw new Error("compose_image_build_failed");
  }
}
