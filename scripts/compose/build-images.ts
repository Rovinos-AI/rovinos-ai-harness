// SPDX-License-Identifier: Apache-2.0
// Builds the Compose images used by integration suites once, before any suite starts. The suites
// then run `up` without `--build`: parallel builds of the same tags on one Docker daemon race
// ("image already exists") and fail cold builds, which made the sandbox and prod-like suites flaky.
// The integration and integration-compose projects both run this setup, possibly at the same time,
// so the build holds a lock directory; the second caller waits, then finds the images cached.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_TIMEOUT_MS = 15 * 60_000;
const lockDirectory = join(
  resolve(fileURLToPath(new URL("../../", import.meta.url))),
  ".tmp",
  "compose-image-build.lock",
);

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isLockStale(): boolean {
  try {
    return Date.now() - statSync(lockDirectory).mtimeMs > BUILD_TIMEOUT_MS;
  } catch {
    return false;
  }
}

/** Takes the build lock, waiting for another setup's build; a lock older than a build is stale. */
export function acquireBuildLock(timeoutMs = BUILD_TIMEOUT_MS, pollMs = 1_000): void {
  mkdirSync(dirname(lockDirectory), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDirectory);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    if (isLockStale()) {
      rmSync(lockDirectory, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error("compose_image_build_failed");
    }
    sleep(pollMs);
  }
}

/** Releases the build lock. */
export function releaseBuildLock(): void {
  rmSync(lockDirectory, { recursive: true, force: true });
}

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
  acquireBuildLock();
  try {
    // sandbox-runner and sandbox-egress-proxy share the harness-sandbox:local tag, so one service per
    // image. Build them one at a time: two parallel `yarn build`s ran the 4 GiB CI Docker VM out of
    // memory (the kernel OOM-killed node inside the build, 2026-10-22).
    for (const service of ["harness", "sandbox-runner"]) {
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
          service,
        ],
        { stdio: "inherit", timeout: BUILD_TIMEOUT_MS },
      );
      if (build.status !== 0) {
        throw new Error("compose_image_build_failed");
      }
    }
  } finally {
    releaseBuildLock();
  }
}
