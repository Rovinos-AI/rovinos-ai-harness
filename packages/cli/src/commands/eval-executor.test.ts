// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import * as evalApi from "@rovinos/eval";
import { HARNESS_VERSION } from "@rovinos/schemas";
import type { TrialExecutor } from "@rovinos/eval";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutput } from "../output.js";
import type { CliContext } from "../command.js";
import type { EvalPackage } from "./eval-types.js";
import { collectTrialEvents, createDefaultExecutor } from "./eval-executor.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-eval-executor-cli-"));
  roots.push(root);
  return root;
}

function context(): CliContext {
  return {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({ stdout: () => undefined, stderr: () => undefined }),
    clock: { now: () => 1 },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI eval executor", () => {
  it("defaults to the in-process executor and configures cassette replay", () => {
    const options = {
      isolation: "inprocess" as const,
      cassette: "replay" as const,
      suiteDirectory: "/synthetic/suite",
      config: HarnessConfigSchema.parse({}),
      exportTelemetry: false,
      context: context(),
    };

    expect(createDefaultExecutor(evalApi, options)).toBeInstanceOf(evalApi.InProcessExecutor);
    expect(() =>
      createDefaultExecutor(evalApi, { ...options, exportTelemetry: true }),
    ).not.toThrow();
  });

  it("uses the CLI-version Docker image default and honors the image override", () => {
    const captured: string[] = [];
    class CapturingDockerExecutor extends evalApi.DockerExecutor {
      constructor(
        options: ConstructorParameters<typeof evalApi.DockerExecutor>[0],
        dependencies?: ConstructorParameters<typeof evalApi.DockerExecutor>[1],
      ) {
        captured.push(options.image);
        super(options, dependencies);
      }
    }
    const api = {
      ...evalApi,
      DockerExecutor: CapturingDockerExecutor,
    } satisfies EvalPackage;
    const options = {
      isolation: "docker" as const,
      cassette: "off" as const,
      suiteDirectory: "/synthetic/suite",
      config: HarnessConfigSchema.parse({}),
      exportTelemetry: false,
      context: context(),
    };

    vi.unstubAllEnvs();
    createDefaultExecutor(api, options);
    vi.stubEnv("HARNESS_EVAL_IMAGE", "synthetic/image:override");
    createDefaultExecutor(api, options);

    expect(captured).toEqual([
      `ghcr.io/rovinos-ai/harness:${HARNESS_VERSION}`,
      "synthetic/image:override",
    ]);
  });

  it("skips missing, budget-skipped, and unexecuted trials when collecting events", async () => {
    const root = await temporaryDirectory();
    const suite = evalApi.EvalSuiteSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: "task", input: { goal: "synthetic" }, graders: [], tags: [] }],
    });
    const variant = evalApi.EvalVariantSchema.parse({ id: "variant" });
    const completed = evalApi.TrialResultSchema.parse({
      status: "completed",
      dbPath: join(root, "completed", "data", "harness.db"),
      workspaceDir: join(root, "completed", "workspace"),
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
    const skipped = evalApi.TrialResultSchema.parse({
      status: "skipped_budget",
      dbPath: join(root, "skipped", "data", "harness.db"),
      workspaceDir: join(root, "skipped", "workspace"),
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
    const records = [
      { taskId: "task", variantId: "variant", trialIndex: 0, seed: 1, result: completed },
      { taskId: "task", variantId: "variant", trialIndex: 1, seed: 2, result: skipped },
      { taskId: "missing", variantId: "variant", trialIndex: 2, seed: 3, result: completed },
      { taskId: "task", variantId: "missing", trialIndex: 3, seed: 4, result: completed },
    ].map((record) =>
      evalApi.EvalTrialRecordSchema.parse({
        schemaVersion: 1,
        suiteCode: evalApi.evalSuiteCode(suite),
        ...record,
      }),
    );
    const executor: TrialExecutor = { run: () => Promise.resolve(completed) };

    const collected = await collectTrialEvents({
      api: evalApi,
      suite,
      variants: [variant],
      records,
      executor,
    });

    expect(collected).toEqual(new Map([[`task\u0000variant\u00000`, []]]));
  });
});
