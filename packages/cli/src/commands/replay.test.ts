// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import { NaiveContext, createRuntime, type ModelCompletion } from "@rovinos/core";
import { FakeModelPort, FakeToolPort } from "@rovinos/core/testing";
import { Event as EventSchema, FakeClock, Id, SequentialIdGenerator, type Event, type NewEvent, parseJson } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import {
  createGoldenSignature,
  GoldenSignatureSchema,
  renderGoldenSignatureJson,
  ResolvedRunSchema,
  replayRun,
  ReplayReportSchema,
} from "@rovinos/replay";
import { describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { replayCommand } from "./replay.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const rootRunId = Id.parse("00000000000000000000000001");
const childRunId = Id.parse("00000000000000000000000002");
const contentCanary = "REPLAY_EVENT_CONTENT_MUST_NOT_BE_PRINTED";

function createdEvent(runId: Id, parentRunId?: Id): NewEvent {
  return {
    runId,
    ts: 1,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "test",
    ...(parentRunId === undefined ? {} : { parentRunId }),
    depth: parentRunId === undefined ? 0 : 1,
  };
}

function contentEvent(runId: Id): NewEvent {
  return {
    runId,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_input",
    input: contentCanary,
    inputKind: "initial",
  };
}

const modelCompletion: ModelCompletion = {
  provider: "test",
  model: "script",
  parts: [{ type: "text", text: "synthetic replay answer" }],
  providerBlobs: null,
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: "stop",
  latencyMs: 1,
  schemaValid: true,
  repairAttempts: 0,
  fallbackDepth: 0,
};

async function recordedEvents(
  runId: Id,
  options: { readonly parentRunId?: Id; readonly sharedTraceId?: string } = {},
): Promise<Event[]> {
  const config = HarnessConfigSchema.parse({});
  const store = new InMemoryEventStore();
  const runtime = await createRuntime(config, {
    store,
    clock: new FakeClock(1),
    ids: new SequentialIdGenerator(),
    context: new NaiveContext(),
    model: new FakeModelPort([modelCompletion]),
    tool: new FakeToolPort(),
    sandboxBackend: { exec: () => Promise.reject(new Error("Unused synthetic sandbox backend")) },
    transientVault: true,
  });
  try {
    const started = runtime.start(contentCanary);
    await started.completion;
    const events: Event[] = [];
    for await (const event of store.read(started.runId)) {
      events.push(
        EventSchema.parse({
          ...event,
          runId,
          segmentId: runId,
          ...(options.sharedTraceId === undefined ? {} : { traceId: options.sharedTraceId }),
          ...(event.type === "run_created" && options.parentRunId !== undefined
            ? { parentRunId: options.parentRunId, depth: 1 }
            : {}),
        }),
      );
    }
    return events;
  } finally {
    await runtime.close();
  }
}

async function createHarness(logs: ReadonlyMap<Id, readonly NewEvent[]>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new InMemoryEventStore();
  for (const [runId, events] of logs) {
    await store.append(runId, events, 0);
  }
  const config = HarnessConfigSchema.parse({});
  const clock = new FakeClock(1);
  const runtime = await createRuntime(config, {
    store,
    clock,
    ids: new SequentialIdGenerator(),
    context: new NaiveContext(),
    model: new FakeModelPort([modelCompletion]),
    tool: new FakeToolPort(),
  });
  const close = vi.spyOn(runtime, "close");
  const context: CliContext = {
    loadConfig: () => Promise.resolve(config),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock,
    createRuntime: () => Promise.resolve(runtime),
  };
  return { context, stdout, stderr, close };
}

function restoreEnvironment(name: "CI" | "GITHUB_ACTIONS", value: string | undefined): void {
  if (name === "CI") {
    if (value === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = value;
    }
    return;
  }
  if (value === undefined) {
    delete process.env.GITHUB_ACTIONS;
  } else {
    process.env.GITHUB_ACTIONS = value;
  }
}

describe("replay command", () => {
  it("replays a run and prints no event content", async () => {
    const harness = await createHarness(new Map([[rootRunId, await recordedEvents(rootRunId)]]));

    await expect(main(["replay", "--run", rootRunId], harness.context, [replayCommand])).resolves.toBe(
      ExitCode.failure,
    );
    expect(harness.stdout.join("")).toContain(rootRunId);
    expect(harness.stdout.join("")).not.toContain(contentCanary);
    expect(harness.stdout.join("")).toContain("status: completed");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("compares a traceparent-resolved root and subagent", async () => {
    const rootEvents = await recordedEvents(rootRunId, { sharedTraceId: traceId });
    const childEvents = await recordedEvents(childRunId, {
      parentRunId: rootRunId,
      sharedTraceId: traceId,
    });
    const harness = await createHarness(
      new Map([
        [rootRunId, rootEvents],
        [childRunId, childEvents],
      ]),
    );

    await expect(
      main(["replay", "--trace", `00-${traceId}-${spanId}-01`], harness.context, [replayCommand]),
    ).resolves.toBe(ExitCode.failure);
    expect(harness.stdout.join("")).toContain(rootRunId);
    expect(harness.stdout.join("")).not.toContain(contentCanary);
  });

  it("rejects baseline options that are missing their required arguments", async () => {
    const harness = await createHarness(new Map([[rootRunId, [createdEvent(rootRunId)]]]));

    await expect(
      main(
        ["replay", "--run", rootRunId, "--update-baseline"],
        harness.context,
        [replayCommand],
      ),
    ).resolves.toBe(ExitCode.usage);
    expect(harness.stderr).toEqual(["replay_input_invalid\n"]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("rejects an unreadable golden file as usage", async () => {
    const harness = await createHarness(new Map([[rootRunId, [createdEvent(rootRunId)]]]));

    await expect(
      main(
        ["replay", "--run", rootRunId, "--golden", "missing-baseline.json"],
        harness.context,
        [replayCommand],
      ),
    ).resolves.toBe(ExitCode.usage);
    expect(harness.stderr).toEqual(["replay_input_invalid\n"]);
  });

  it("compares golden signatures and makes noise fail only in strict mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-golden-"));
    const baselinePath = join(directory, "baseline.json");
    const noisyBaselinePath = join(directory, "noisy-baseline.json");
    const events = await recordedEvents(rootRunId);
    const config = HarnessConfigSchema.parse({});
    const resolved = ResolvedRunSchema.parse({
      rootRunId,
      runs: [{ runId: rootRunId, role: "root", events }],
    });
    const expectedOutcome = await replayRun(resolved, { config: { run: config.run } });
    const expectedGolden = createGoldenSignature(expectedOutcome.events);
    const noisyGolden = GoldenSignatureSchema.parse({
      ...expectedGolden,
      signature: expectedGolden.signature.map((event) =>
        event.kind === "model_call" && typeof event.latencyMs === "number"
          ? { ...event, latencyMs: event.latencyMs + 10 }
          : event,
      ),
    });
    await writeFile(baselinePath, renderGoldenSignatureJson(expectedGolden));
    await writeFile(noisyBaselinePath, renderGoldenSignatureJson(noisyGolden));

    try {
      const matchingHarness = await createHarness(new Map([[rootRunId, events]]));
      await expect(
        main(
          ["replay", "--run", rootRunId, "--golden", baselinePath],
          matchingHarness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.ok);
      expect(matchingHarness.stdout.join("")).toContain("goldenMatch: true");

      const nonStrictHarness = await createHarness(new Map([[rootRunId, events]]));
      await expect(
        main(
          ["replay", "--run", rootRunId, "--golden", noisyBaselinePath],
          nonStrictHarness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.ok);

      const strictHarness = await createHarness(new Map([[rootRunId, events]]));
      await expect(
        main(
          ["replay", "--run", rootRunId, "--golden", noisyBaselinePath, "--strict"],
          strictHarness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.failure);
      expect(strictHarness.stdout.join("")).toContain("goldenMatch: false");
      expect(strictHarness.stdout.join("")).toContain("noise");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a schema-validated JSON report when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-report-"));
    const reportPath = join(directory, "report.json");
    const harness = await createHarness(new Map([[rootRunId, await recordedEvents(rootRunId)]]));

    try {
      await main(
        ["replay", "--run", rootRunId, "--report", reportPath],
        harness.context,
        [replayCommand],
      );
      const report = parseJson(ReplayReportSchema, await readFile(reportPath, "utf8"));

      expect(report.originalRunId).toBe(rootRunId);
      expect(harness.stdout.join("")).not.toContain(contentCanary);
      expect((await readFile(reportPath, "utf8"))).not.toContain(contentCanary);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits one validated report document in JSON mode", async () => {
    const harness = await createHarness(new Map([[rootRunId, await recordedEvents(rootRunId)]]));

    await main(["--json", "replay", "--run", rootRunId], harness.context, [replayCommand]);
    const report = parseJson(ReplayReportSchema, harness.stdout[0] ?? "");

    expect(report.originalRunId).toBe(rootRunId);
    expect(harness.stdout).toHaveLength(1);
    expect(harness.stdout.join("")).not.toContain(contentCanary);
  });

  it("updates a baseline explicitly and reports the accepted diff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-baseline-"));
    const baselinePath = join(directory, "baseline.json");
    const events = await recordedEvents(rootRunId);
    await writeFile(baselinePath, renderGoldenSignatureJson(createGoldenSignature([])));
    const harness = await createHarness(new Map([[rootRunId, events]]));
    const originalCi = process.env.CI;
    const originalActions = process.env.GITHUB_ACTIONS;
    process.env.CI = "1";
    delete process.env.GITHUB_ACTIONS;

    try {
      await expect(
        main(
          [
            "replay",
            "--run",
            rootRunId,
            "--golden",
            baselinePath,
            "--update-baseline",
            "--force-in-ci",
          ],
          harness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.ok);
      const updated = parseJson(GoldenSignatureSchema, await readFile(baselinePath, "utf8"));

      expect(updated.signature.length).toBeGreaterThan(0);
      expect(harness.stdout.join("")).toContain("goldenMatch: true");
    } finally {
      restoreEnvironment("CI", originalCi);
      restoreEnvironment("GITHUB_ACTIONS", originalActions);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses baseline updates in CI unless explicitly forced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-ci-baseline-"));
    const baselinePath = join(directory, "baseline.json");
    const baseline = renderGoldenSignatureJson(createGoldenSignature([]));
    await writeFile(baselinePath, baseline);
    const harness = await createHarness(new Map([[rootRunId, await recordedEvents(rootRunId)]]));
    const originalCi = process.env.CI;
    process.env.CI = "1";

    try {
      await expect(
        main(
          ["replay", "--run", rootRunId, "--golden", baselinePath, "--update-baseline"],
          harness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.usage);
      expect(harness.stderr).toEqual(["baseline_update_refused\n"]);
      expect(await readFile(baselinePath, "utf8")).toBe(baseline);
    } finally {
      restoreEnvironment("CI", originalCi);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not rewrite a baseline after replay divergence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-divergent-baseline-"));
    const baselinePath = join(directory, "baseline.json");
    const baseline = renderGoldenSignatureJson(createGoldenSignature([]));
    await writeFile(baselinePath, baseline);
    const harness = await createHarness(
      new Map([[rootRunId, [createdEvent(rootRunId), contentEvent(rootRunId)]]]),
    );

    try {
      await expect(
        main(
          ["replay", "--run", rootRunId, "--golden", baselinePath, "--update-baseline"],
          harness.context,
          [replayCommand],
        ),
      ).resolves.toBe(ExitCode.replayFailed);
      expect(await readFile(baselinePath, "utf8")).toBe(baseline);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps missing selectors and both selectors to usage", async () => {
    const harness = await createHarness(new Map());

    await expect(main(["replay"], harness.context, [replayCommand])).resolves.toBe(ExitCode.usage);
    await expect(
      main(
        ["replay", "--run", rootRunId, "--trace", traceId],
        harness.context,
        [replayCommand],
      ),
    ).resolves.toBe(ExitCode.usage);
    expect(harness.stderr).toEqual(["replay_input_invalid\n", "replay_input_invalid\n"]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("maps unknown runs to the not-found error", async () => {
    const harness = await createHarness(new Map());

    await expect(
      main(["replay", "--run", rootRunId], harness.context, [replayCommand]),
    ).resolves.toBe(ExitCode.failure);
    expect(harness.stderr).toEqual(["run_not_found\n"]);
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
