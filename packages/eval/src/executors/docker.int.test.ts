// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDockerAvailable } from "@rovinos/sandbox";
import type { ModelPort } from "@rovinos/core";
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
  it("completes through the live host model socket with no container network", async () => {
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(join(testRoot, "trial-"));
    directories.push(root);
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    const user = `${String(uid > 0 ? uid : 65532)}:${String(gid > 0 ? gid : 65532)}`;
    let calls = 0;
    const model: ModelPort = {
      complete: () => {
        calls += 1;
        return Promise.resolve({
          provider: "synthetic",
          model: "synthetic",
          parts: [{ type: "text", text: "Synthetic Docker trial complete." }],
          providerBlobs: null,
          usage: { inputTokens: 3, outputTokens: 2 },
          finishReason: "stop",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
        });
      },
    };
    const trial = makeTrial(join(root, "run"));
    const executor = new DockerExecutor({ image, user }, { liveModel: { model: () => model } });
    const result = await executor.run(trial);
    const events = await executor.eventsFor(trial);

    expect(result.dbPath).toBe(join(root, "run", "data", "harness.db"));
    expect(result.workspaceDir).toBe(join(root, "run", "workspace"));
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, costMicros: 0 });
    expect(calls).toBe(1);
    expect(events.some((event) => event.type === "model_response")).toBe(true);
  });
});
