// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FakeClock,
  Id,
  ModelsConfigSchema,
  parseJson,
  SequentialIdGenerator,
} from "@rovinos/schemas";
import type { ModelPort, PolicyPort, ToolPort } from "@rovinos/core";
import { createRuntime } from "@rovinos/core";
import type * as SandboxModule from "@rovinos/sandbox";
import type { DockerProcessOptions, DockerProcessResult } from "@rovinos/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSuite } from "../load.js";
import { TrialConfigSchema } from "../executor.js";
import { evalSuiteCode } from "../trial.js";
import type { TrialSpec } from "../trial.js";
import { createNoCanaryLeakGrader } from "../graders/no-canary-leak.js";
import { trialLogSinks } from "../execution-capture.js";

const mocks = vi.hoisted(() => ({
  runDockerProcess: vi.fn(),
  startLiveModelGateway: vi.fn(),
}));

vi.mock("../live-model-gateway.js", () => ({
  startLiveModelGateway: mocks.startLiveModelGateway,
}));

vi.mock("@rovinos/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runDockerProcess: mocks.runDockerProcess };
});

import { DockerExecutor } from "./docker.js";

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const path = await mkdtemp(join(process.cwd(), ".harness-eval-docker-"));
  directories.push(path);
  return path;
}

function makeTrial(workDir: string, human?: unknown): TrialSpec {
  const suite = defineSuite({
    schemaVersion: 1,
    tasks: [
      {
        id: "docker_task",
        input: { goal: "A synthetic goal." },
        ...(human === undefined ? {} : { human }),
        graders: [],
        tags: [],
      },
    ],
  });
  const task = suite.tasks[0];
  if (task === undefined) {
    throw new Error("docker_task_missing");
  }
  const variant = { id: "baseline" };
  return {
    suite,
    task,
    variantId: variant.id,
    variant,
    trialIndex: 0,
    seed: 7,
    workDir,
  };
}

function model(): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        provider: "synthetic",
        model: "synthetic",
        parts: [{ type: "text", text: "done" }],
        providerBlobs: null,
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
      }),
  };
}

interface ApprovalScenario {
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly policy: PolicyPort;
}

function approvalScenario(repeatApprovals = false): ApprovalScenario {
  let modelCalls = 0;
  return {
    model: {
      complete: () => {
        modelCalls += 1;
        const call = repeatApprovals || modelCalls === 1;
        return Promise.resolve({
          provider: "synthetic",
          model: "synthetic",
          parts: call
            ? [
                {
                  type: "tool_call" as const,
                  callId: Id.parse(String(modelCalls).padStart(26, "0")),
                  toolId: "fake.echo",
                  args: { value: "synthetic" },
                },
              ]
            : [{ type: "text" as const, text: "done" }],
          providerBlobs: null,
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: call ? "tool_calls" : "stop",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
        });
      },
    },
    tool: {
      prepare: (call) => Promise.resolve(call),
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      getToolSpecs: () => [
        { toolId: "fake.echo", description: "Synthetic echo tool", inputSchema: {} },
      ],
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    },
    policy: {
      version: "synthetic",
      decide: () => ({
        decision: "ask",
        ruleId: "eval_approval",
        reason: "synthetic_approval",
        editable: [],
      }),
    },
  };
}

async function createRun(
  workDir: string,
  key: string,
  run: boolean,
  scenario?: ApprovalScenario,
  ids = new SequentialIdGenerator(),
): Promise<void> {
  const config = parseJson(
    TrialConfigSchema,
    await readFile(join(workDir, "harness.config.json"), "utf8"),
  );
  const runtime = await createRuntime(
    {
      run: config.run,
      roles: config.roles,
      store: config.store,
      keys: config.keys,
      models: config.models,
      policy: config.policy,
      pii: config.pii,
      vault: config.vault,
    },
    {
      dataDir: join(workDir, "data"),
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000),
      ids,
      model: scenario?.model ?? model(),
      ...(scenario === undefined ? {} : { tool: scenario.tool, policy: scenario.policy }),
      secretResolver: { resolve: () => Promise.resolve({ reveal: () => key }) },
    },
  );
  try {
    if (run) {
      await runtime.run({ goal: "A synthetic goal." });
    } else {
      const summary = (await runtime.store.listRuns({ limit: 1 })).runs[0];
      if (summary === undefined) {
        throw new Error("synthetic_run_missing");
      }
      await runtime.resume(summary.runId);
    }
  } finally {
    await runtime.close();
  }
}

async function createEmptyRunStore(workDir: string, key: string): Promise<void> {
  const config = parseJson(
    TrialConfigSchema,
    await readFile(join(workDir, "harness.config.json"), "utf8"),
  );
  const runtime = await createRuntime(
    {
      run: config.run,
      roles: config.roles,
      store: config.store,
      keys: config.keys,
      models: config.models,
      policy: config.policy,
      pii: config.pii,
      vault: config.vault,
    },
    {
      dataDir: join(workDir, "data"),
      transientVault: false,
      clock: new FakeClock(1_700_000_000_000),
      ids: new SequentialIdGenerator(),
      model: model(),
      secretResolver: { resolve: () => Promise.resolve({ reveal: () => key }) },
    },
  );
  await runtime.close();
}

afterEach(async () => {
  mocks.runDockerProcess.mockReset();
  mocks.startLiveModelGateway.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DockerExecutor", () => {
  it("uses only the host model socket with no container network or provider configuration", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    const socketPath = join(root, "model.sock");
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const hostModel = model();
    const trial = makeTrial(workDir);
    const selectModel = vi.fn((candidate: TrialSpec) => {
      expect(candidate).toBe(trial);
      return hostModel;
    });
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath, close });
    vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-secret");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "synthetic-azure-secret");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-aws-secret");
    vi.stubEnv("DOCKER_HOST", "unix:///synthetic/docker.sock");
    let invocation: DockerProcessOptions | undefined;
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      invocation = options;
      expect(close).not.toHaveBeenCalled();
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, true);
      return { exitCode: 0, timedOut: false };
    });
    const result = await new DockerExecutor(
      { image: "synthetic/harness", network: "synthetic-network" },
      {
        liveModel: { model: selectModel },
        models: ModelsConfigSchema.parse({
          providers: [
            {
              id: "synthetic",
              kind: "openai_compatible",
              baseUrl: "https://provider.synthetic",
              apiKey: "env:OPENAI_API_KEY",
            },
          ],
          routing: { default: [{ provider: "synthetic", model: "synthetic" }] },
        }),
      },
    ).run(trial);

    expect(result.status).toBe("completed");
    expect(selectModel).toHaveBeenCalledWith(trial);
    expect(mocks.startLiveModelGateway).toHaveBeenCalledExactlyOnceWith(hostModel, {});
    expect(invocation?.args).toContain(
      `type=bind,source=${socketPath},target=/run/harness-model.sock`,
    );
    expect(invocation?.args).not.toContain(`type=bind,source=${root},target=/run`);
    expect(invocation?.args).toContain("HARNESS_EVAL_MODEL_SOCKET=/run/harness-model.sock");
    expect(invocation?.args).toContain("none");
    expect(invocation?.args).not.toContain("synthetic-network");
    expect(invocation?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(invocation?.env).not.toHaveProperty("AZURE_OPENAI_API_KEY");
    expect(invocation?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(invocation?.env.DOCKER_HOST).toBe("unix:///synthetic/docker.sock");
    const persisted = await readFile(join(workDir, "harness.config.json"), "utf8");
    expect(persisted).not.toContain("OPENAI_API_KEY");
    expect(persisted).not.toContain("provider.synthetic");
    expect(parseJson(TrialConfigSchema, persisted).models).toMatchObject({
      providers: [],
      routing: { default: [{ provider: "synthetic", model: "synthetic" }] },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the live model gateway on Docker failure", async () => {
    const root = await createDirectory();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath: join(root, "model.sock"), close });
    mocks.runDockerProcess.mockRejectedValue(new Error("synthetic-process-error"));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }, { liveModel: { model } }).run(
        makeTrial(join(root, "trial")),
      ),
    ).rejects.toMatchObject({ code: "docker_process_failed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the live model gateway after a timed-out process", async () => {
    const root = await createDirectory();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath: join(root, "model.sock"), close });
    mocks.runDockerProcess.mockResolvedValue({ exitCode: null, timedOut: true });
    const result = await new DockerExecutor(
      { image: "synthetic/harness" },
      { liveModel: { model } },
    ).run(makeTrial(join(root, "trial")));
    expect(result).toMatchObject({ status: "error", errorCode: "trial_timeout" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("never launches Docker when the live trial is already cancelled", async () => {
    const root = await createDirectory();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const controller = new AbortController();
    controller.abort();
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath: join(root, "model.sock"), close });
    await expect(
      new DockerExecutor(
        { image: "synthetic/harness" },
        { liveModel: { model, signal: controller.signal } },
      ).run(makeTrial(join(root, "trial"))),
    ).rejects.toMatchObject({ code: "docker_process_cancelled" });
    expect(mocks.runDockerProcess).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("forwards cancellation to the sandbox process and closes the gateway", async () => {
    const root = await createDirectory();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const controller = new AbortController();
    const hostModel = model();
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath: join(root, "model.sock"), close });
    const invocations: DockerProcessOptions[] = [];
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      invocations.push(options);
      return new Promise<DockerProcessResult>((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve({ exitCode: 137, timedOut: false });
          },
          { once: true },
        );
        queueMicrotask(() => {
          controller.abort();
        });
      });
    });
    await expect(
      new DockerExecutor(
        { image: "synthetic/harness" },
        { liveModel: { model: () => hostModel, signal: controller.signal } },
      ).run(makeTrial(join(root, "trial"))),
    ).rejects.toMatchObject({ code: "docker_process_cancelled" });
    expect(mocks.startLiveModelGateway).toHaveBeenCalledWith(hostModel, {
      signal: controller.signal,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.signal).toBe(controller.signal);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects live model config overrides before persisting a trial", async () => {
    const workDir = join(await createDirectory(), "trial");
    const trial = makeTrial(workDir);
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }, { liveModel: { model } }).run({
        ...trial,
        variant: { ...trial.variant, configOverrides: { models: { routing: { default: [] } } } },
      }),
    ).rejects.toMatchObject({ code: "live_model_config_override" });
    expect(mocks.startLiveModelGateway).not.toHaveBeenCalled();
    expect(mocks.runDockerProcess).not.toHaveBeenCalled();
    await expect(readFile(join(workDir, "harness.config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses the isolated database to collect run status and usage", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    const trial = makeTrial(workDir);
    let invocation: DockerProcessOptions | undefined;
    let now = 0;
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      invocation = options;
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, true);
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "synthetic container stdout",
        stderr: "synthetic container stderr",
      } satisfies DockerProcessResult;
    });

    const executor = new DockerExecutor(
      { image: "synthetic/harness" },
      {
        clock: { now: () => (now += 10) },
        randomBytes: (size) => new Uint8Array(size).fill(9),
      },
    );
    const result = await executor.run(trial);
    const events = await executor.eventsFor(trial);

    expect(result.status).toBe("completed");
    expect(result.runId).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, costMicros: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "run_created")).toBe(true);
    expect(trialLogSinks(result.dbPath)).toEqual([
      { name: "stdout", content: "synthetic container stdout" },
      { name: "stderr", content: "synthetic container stderr" },
    ]);
    expect(invocation?.env.HARNESS_EVAL_KEY).toBe(Buffer.alloc(32, 9).toString("base64"));
    expect(invocation?.args).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(invocation?.args).toContain(
      `HARNESS_EVAL_METADATA=${JSON.stringify({
        suite: evalSuiteCode(trial.suite),
        task: trial.task.id,
        trial: trial.trialIndex,
      })}`,
    );
    // threat: T-02, T-07, T-08, T-16
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--interactive",
        "--input",
        "-",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--tmpfs",
        "/tmp:size=64m,noexec,nosuid,nodev",
        "--user",
        "65532:65532",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
      ]),
    );
    expect(invocation?.input).toBe(JSON.stringify({ goal: "A synthetic goal." }));
    expect(invocation?.args).toContain("--entrypoint");
    const imageIndex = invocation?.args.indexOf("synthetic/harness") ?? -1;
    expect(invocation?.args.slice(imageIndex, imageIndex + 3)).toEqual([
      "synthetic/harness",
      "/app/dist/bin.js",
      "--config",
    ]);
    expect(JSON.stringify(invocation?.args)).not.toContain("A synthetic goal.");
  });

  it("passes explicit telemetry export settings only with the opt-in", async () => {
    const workDir = join(await createDirectory(), "trial");
    let args: readonly string[] = [];
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.synthetic:4318");
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      args = options.args;
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    });

    await new DockerExecutor({ image: "synthetic/harness" }, { exportTelemetry: true }).run(
      makeTrial(workDir),
    );

    expect(args).toContain("--env");
    expect(args).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(JSON.stringify(args)).not.toContain("collector.synthetic");
  });

  it("resolves and resumes approvals through the simulated human", async () => {
    const root = await createDirectory();
    const workDir = join(root, "trial");
    const scenario = approvalScenario();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const socketPath = join(root, "model.sock");
    mocks.startLiveModelGateway.mockResolvedValue({ socketPath, close });
    const invocations: DockerProcessOptions[] = [];
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      invocations.push(options);
      expect(close).not.toHaveBeenCalled();
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, !options.args.includes("resume"), scenario);
      return {
        exitCode: options.args.includes("resume") ? 0 : 1,
        timedOut: false,
      } satisfies DockerProcessResult;
    });

    const result = await new DockerExecutor(
      { image: "synthetic/harness" },
      { liveModel: { model: () => scenario.model } },
    ).run(
      makeTrial(workDir, {
        rules: [],
        default: "approve",
        unsafeAutoApprove: true,
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      approvals: { approved: 1, denied: 0, edited: 0 },
      unsafeAutoApprove: true,
    });
    expect(invocations).toHaveLength(2);
    expect(mocks.startLiveModelGateway).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    for (const invocation of invocations) {
      expect(invocation.args).toContain(
        `type=bind,source=${socketPath},target=/run/harness-model.sock`,
      );
    }
    expect(invocations[1]?.args).toContain("resume");
    const imageIndex = invocations[1]?.args.indexOf("synthetic/harness") ?? -1;
    expect(invocations[1]?.args.slice(imageIndex, imageIndex + 3)).toEqual([
      "synthetic/harness",
      "/app/dist/bin.js",
      "--config",
    ]);
    expect(invocations[1]?.args.at(-1)).toBe(result.runId);
    expect(invocations[1]?.args).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(invocations[1]?.args).toContain(
      `HARNESS_EVAL_METADATA=${JSON.stringify({
        suite: evalSuiteCode(
          makeTrial(workDir, {
            rules: [],
            default: "approve",
            unsafeAutoApprove: true,
          }).suite,
        ),
        task: "docker_task",
        trial: 0,
      })}`,
    );
  });

  it("reports when the simulated human exceeds its resume limit", async () => {
    const workDir = join(await createDirectory(), "trial");
    const scenario = approvalScenario(true);
    const ids = new SequentialIdGenerator();
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, !options.args.includes("resume"), scenario, ids);
      return { exitCode: 0, timedOut: false } satisfies DockerProcessResult;
    });

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir, {
        rules: [],
        default: "approve",
        unsafeAutoApprove: true,
        maxResumes: 1,
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "human_max_resumes_exceeded",
      approvals: { approved: 1 },
    });
  });

  it("does not pass telemetry export settings to a resume process by default", async () => {
    const workDir = join(await createDirectory(), "trial");
    const scenario = approvalScenario();
    const invocations: DockerProcessOptions[] = [];
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.synthetic:4318");
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      invocations.push(options);
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createRun(workDir, key, !options.args.includes("resume"), scenario);
      return { exitCode: 0, timedOut: false } satisfies DockerProcessResult;
    });

    await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir, { rules: [], default: "approve", unsafeAutoApprove: true }),
    );

    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.args).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(JSON.stringify(invocations[1]?.args)).not.toContain("collector.synthetic");
  });

  it("includes resumed Docker output in the no-canary leak scan", async () => {
    const workDir = join(await createDirectory(), "trial");
    const scenario = approvalScenario();
    const canary = "synthetic-resume-output@example.test";
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      const isResume = options.args.includes("resume");
      await createRun(workDir, key, !isResume, scenario);
      return {
        exitCode: 0,
        timedOut: false,
        stdout: isResume ? canary : "",
        stderr: "",
      } satisfies DockerProcessResult;
    });

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir, { rules: [], default: "approve", unsafeAutoApprove: true }),
    );
    const grade = await createNoCanaryLeakGrader({ canaries: [canary] }).grade({ result });

    expect(trialLogSinks(result.dbPath)).toContainEqual({ name: "stdout", content: canary });
    expect(grade.codes).toContain("canary_in_logs");
  });

  it("reports a timeout if the Docker resume process times out", async () => {
    const workDir = join(await createDirectory(), "trial");
    const scenario = approvalScenario();
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      if (options.args.includes("resume")) {
        return { exitCode: null, timedOut: true } satisfies DockerProcessResult;
      }
      await createRun(workDir, key, true, scenario);
      return { exitCode: 1, timedOut: false } satisfies DockerProcessResult;
    });

    const result = await new DockerExecutor({ image: "synthetic/harness" }).run(
      makeTrial(workDir, { rules: [], default: "deny", maxResumes: 1 }),
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "trial_timeout",
      exitCode: 124,
      approvals: { denied: 1 },
    });
  });

  it("returns a safe error when Docker exits without creating a run", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockResolvedValue({
      exitCode: 17,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    const trial = makeTrial(workDir);
    const executor = new DockerExecutor({ image: "synthetic/harness" });
    const result = await executor.run(trial);
    const events = await executor.eventsFor(trial);

    expect(result).toMatchObject({
      status: "error",
      errorCode: "docker_exit_nonzero",
      exitCode: 17,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
    expect(events).toEqual([]);
  });

  it("returns a safe result and no events when Docker creates an empty run store", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockImplementation(async (options: DockerProcessOptions) => {
      const key = options.env.HARNESS_EVAL_KEY;
      if (key === undefined) {
        throw new Error("synthetic_key_missing");
      }
      await createEmptyRunStore(workDir, key);
      return { exitCode: 0, timedOut: false } satisfies DockerProcessResult;
    });
    const trial = makeTrial(workDir);
    const executor = new DockerExecutor({ image: "synthetic/harness" });

    const result = await executor.run(trial);
    const events = await executor.eventsFor(trial);

    expect(result.status).toBe("error");
    expect(events).toEqual([]);
  });

  it("enforces the wall-clock timeout and kills the named container", async () => {
    const workDir = join(await createDirectory(), "trial");
    let containerName: string | undefined;
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      containerName = options.containerName;
      return Promise.resolve({ exitCode: null, timedOut: true, stdout: "", stderr: "" });
    });

    const pending = new DockerExecutor({
      image: "synthetic/harness",
      timeoutMs: 5,
    }).run(makeTrial(workDir));
    const result = await pending;

    expect(result).toMatchObject({ status: "error", errorCode: "trial_timeout" });
    expect(containerName).toMatch(/^harness-eval-/u);
  });

  it("accepts bounded resource overrides while requiring a non-root user", async () => {
    const workDir = join(await createDirectory(), "trial");
    let args: string[] = [];
    mocks.runDockerProcess.mockImplementation((options: DockerProcessOptions) => {
      args = [...options.args];
      return Promise.resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: "" });
    });

    await new DockerExecutor({
      image: "synthetic/harness",
      memory: "512m",
      cpus: 2,
      pidsLimit: 64,
      tmpfsSize: "128m",
      user: "1001:1001",
      cliPath: "/opt/harness/bin.js",
    }).run(makeTrial(workDir));

    expect(args).toEqual(
      expect.arrayContaining([
        "/tmp:size=128m,noexec,nosuid,nodev",
        "--user",
        "1001:1001",
        "--memory",
        "512m",
        "--cpus",
        "2",
        "--pids-limit",
        "64",
        "/opt/harness/bin.js",
      ]),
    );
    expect(() => new DockerExecutor({ image: "synthetic/harness", user: "0:0" })).toThrow();
  });

  it("returns typed process errors without leaking details", async () => {
    const workDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockRejectedValueOnce(new Error("synthetic private path"));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });

    const secondWorkDir = join(await createDirectory(), "trial");
    mocks.runDockerProcess.mockRejectedValueOnce(new Error("synthetic private path"));
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(secondWorkDir)),
    ).rejects.toMatchObject({ code: "docker_process_failed" });
  });

  it("rejects mount paths with commas using a typed error", async () => {
    const workDir = join(await createDirectory(), "trial,invalid");
    await expect(
      new DockerExecutor({ image: "synthetic/harness" }).run(makeTrial(workDir)),
    ).rejects.toMatchObject({ code: "docker_mount_path_invalid" });
  });
});
