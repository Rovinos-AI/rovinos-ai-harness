// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { defineSuite } from "./load.js";
import { prepareTrial, TrialConfigSchema } from "./executor.js";
import type { EvalVariant, TrialSpec } from "./trial.js";

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-eval-"));
  directories.push(path);
  return path;
}

function trial(workDir: string, fixtureDir?: string, policyFile?: string): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "synthetic_task",
        input: { goal: "A synthetic goal." },
        ...(fixtureDir === undefined ? {} : { workspace: { fixtureDir } }),
        ...(policyFile === undefined ? {} : { policyFile }),
        graders: [],
        tags: [],
      },
    ],
  });
  const task = suite.tasks[0];
  if (task === undefined) {
    throw new Error("synthetic_task_missing");
  }
  const variant: EvalVariant = {
    id: "baseline",
    budgets: { maxSteps: 4 },
    cassetteMode: "replay",
  };
  return {
    suite,
    task,
    variantId: variant.id,
    variant,
    trialIndex: 0,
    seed: 42,
    workDir,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("prepareTrial", () => {
  it("copies the fixture and policy and writes only references to key material", async () => {
    const root = await createDirectory();
    const fixture = join(root, "fixture");
    const policy = join(root, "policy.yaml");
    const workDir = join(root, "trial");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fixture));
    await writeFile(join(fixture, "fixture.txt"), "synthetic fixture", "utf8");
    await writeFile(policy, "version: 1\n", "utf8");

    const prepared = await prepareTrial(trial(workDir, fixture, policy));
    const content = await readFile(prepared.configPath, "utf8");
    const config = parseJson(TrialConfigSchema, content);
    const evalOptions = await readFile(prepared.evalOptionsPath, "utf8");

    expect(await readFile(join(prepared.workspaceDir, "fixture.txt"), "utf8")).toBe(
      "synthetic fixture",
    );
    expect(await readFile(prepared.policyPath ?? "", "utf8")).toBe("version: 1\n");
    expect(config.policy.file).toBe("policy.yaml");
    expect(config.run.budgets.maxSteps).toBe(4);
    expect(content).not.toContain(prepared.key);
    expect(config.keys.keys[0]?.secret).toBe("env:HARNESS_EVAL_KEY");
    expect(prepared.runtimeConfig.store).toEqual(config.store);
    expect(content).not.toContain("A synthetic goal.");
    expect(evalOptions).toContain('"cassetteMode":"replay"');
    expect(prepared.dbPath).not.toBe(join(root, "another", "data", "harness.db"));
  });

  it("creates distinct databases, workspaces, and per-trial keys", async () => {
    const root = await createDirectory();
    const first = await prepareTrial(trial(join(root, "first")));
    const second = await prepareTrial(trial(join(root, "second")));

    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.workspaceDir).not.toBe(second.workspaceDir);
    expect(first.key).not.toBe(second.key);
    await expect(prepareTrial(trial(join(root, "first")))).rejects.toThrow();
  });

  it("rejects a filesystem root as a trial directory", async () => {
    await expect(prepareTrial(trial("/"))).rejects.toThrow("trial_workdir_invalid");
  });
});
