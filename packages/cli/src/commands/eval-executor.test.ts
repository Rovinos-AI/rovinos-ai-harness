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

function liveConfig() {
  return HarnessConfigSchema.parse({
    models: {
      providers: [
        {
          id: "local",
          kind: "openai_compatible",
          trust: "local",
          baseUrl: "https://provider.example.invalid/v1",
        },
      ],
      routing: { default: [{ provider: "local", model: "baseline" }] },
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
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

  it.each(["docker", "inprocess"] as const)(
    "keeps live providers on the host and selects each trial route for %s",
    async (isolation) => {
      const config = liveConfig();
      const session = await evalApi.createLiveModelSession({ models: config.models, maxCalls: 2 });
      const modelFor = vi.spyOn(session, "modelFor").mockReturnValue(session.model);
      let received: ConstructorParameters<typeof evalApi.DockerExecutor>[1];
      class Docker extends evalApi.DockerExecutor {
        constructor(
          options: ConstructorParameters<typeof evalApi.DockerExecutor>[0],
          dependencies?: ConstructorParameters<typeof evalApi.DockerExecutor>[1],
        ) {
          super(options, dependencies);
          received = dependencies;
        }
      }
      class InProcess extends evalApi.InProcessExecutor {
        constructor(options: ConstructorParameters<typeof evalApi.InProcessExecutor>[0]) {
          super(options);
          received = options;
        }
      }
      const ctx = context();
      const signal = new AbortController().signal;
      try {
        createDefaultExecutor(
          { ...evalApi, DockerExecutor: Docker, InProcessExecutor: InProcess },
          {
            isolation,
            cassette: "off",
            suiteDirectory: "/synthetic",
            config,
            exportTelemetry: false,
            context: ctx,
            liveSession: session,
            signal,
          },
        );

        const suite = evalApi.EvalSuiteSchema.parse({
          schemaVersion: 1,
          tasks: [{ id: "task", input: { goal: "synthetic" }, graders: [], tags: [] }],
        });
        const trial = evalApi.TrialSpecSchema.parse({
          suite,
          task: suite.tasks[0],
          variantId: "candidate",
          variant: { id: "candidate", models: [{ provider: "local", model: "candidate" }] },
          trialIndex: 0,
          seed: 1,
          workDir: "/synthetic/trial",
        });
        expect(received?.models?.providers).toEqual([]);
        expect(received?.clock).toBe(ctx.clock);
        expect(received?.liveModel?.signal).toBe(signal);
        expect(received?.liveModel?.model(trial)).toBe(session.model);
        expect(modelFor).toHaveBeenCalledWith(
          expect.objectContaining({ default: [{ provider: "local", model: "candidate" }] }),
        );
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    ["DOCKER_HOST", "tcp://127.0.0.1:2375"],
    ["DOCKER_CONTEXT", "remote"],
  ])("rejects unsupported live Docker setting %s before starting a trial", async (name, value) => {
    const config = liveConfig();
    const session = await evalApi.createLiveModelSession({ models: config.models, maxCalls: 1 });
    vi.stubEnv(name, value);
    try {
      expect(() =>
        createDefaultExecutor(evalApi, {
          isolation: "docker",
          cassette: "off",
          suiteDirectory: "/synthetic",
          config,
          exportTelemetry: false,
          context: context(),
          liveSession: session,
        }),
      ).toThrow(expect.objectContaining({ code: "eval_live_docker_host_unavailable" }));
    } finally {
      await session.close();
    }
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
