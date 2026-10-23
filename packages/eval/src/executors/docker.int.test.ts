// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDockerAvailable } from "@harness/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { defineSuite } from "../load.js";
import { DockerExecutor } from "./docker.js";
import type { TrialSpec } from "../trial.js";

const image = process.env.HARNESS_EVAL_IMAGE ?? "harness:local";
const dockerAvailable = isDockerAvailable();
const testRoot = join(process.cwd(), ".tmp", "eval-docker-integration");
const directories: string[] = [];

function makeTrial(workDir: string): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "docker_smoke",
        input: { goal: "A synthetic integration goal." },
        graders: [],
        tags: [],
      },
    ],
  });
  const task = suite.tasks[0];
  if (task === undefined) {
    throw new Error("docker_task_missing");
  }
  const variant = { id: "isolated" };
  return {
    suite,
    task,
    variantId: variant.id,
    variant,
    trialIndex: 0,
    seed: 1,
    workDir,
  };
}

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!dockerAvailable)("@docker DockerExecutor", () => {
  it("runs the harness container with no network and collects its result", async () => {
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(join(testRoot, "trial-"));
    directories.push(root);
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    const user = `${String(uid > 0 ? uid : 65532)}:${String(gid > 0 ? gid : 65532)}`;
    const result = await new DockerExecutor({ image, user }).run(makeTrial(join(root, "run")));

    expect(result.dbPath).toBe(join(root, "run", "data", "harness.db"));
    expect(result.workspaceDir).toBe(join(root, "run", "workspace"));
    expect(["completed", "failed", "suspended", "cancelled", "error"]).toContain(result.status);
  });
});
