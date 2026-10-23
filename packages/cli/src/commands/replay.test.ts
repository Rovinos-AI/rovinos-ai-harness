// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import { NaiveContext, createRuntime, type ModelCompletion } from "@harness/core";
import { FakeModelPort, FakeToolPort } from "@harness/core/testing";
import { FakeClock, Id, SequentialIdGenerator, type NewEvent } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
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
  parts: [{ type: "text", text: "unused replay command model" }],
  providerBlobs: null,
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: "stop",
  latencyMs: 1,
  schemaValid: true,
  repairAttempts: 0,
  fallbackDepth: 0,
};

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

describe("replay command", () => {
  it("resolves a run id and prints no event content", async () => {
    const harness = await createHarness(
      new Map([[rootRunId, [createdEvent(rootRunId), contentEvent(rootRunId)]]]),
    );

    await expect(
      main(
        [
          "replay",
          "--run",
          rootRunId,
          "--strict",
          "--golden",
          "baseline.json",
          "--update-baseline",
          "--report",
          "report.json",
        ],
        harness.context,
        [replayCommand],
      ),
    ).resolves.toBe(ExitCode.ok);
    expect(harness.stdout.join("")).toContain(rootRunId);
    expect(harness.stdout.join("")).not.toContain(contentCanary);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("resolves a traceparent and prints the root and subagent ids", async () => {
    const harness = await createHarness(
      new Map([
        [rootRunId, [createdEvent(rootRunId)]],
        [childRunId, [createdEvent(childRunId, rootRunId)]],
      ]),
    );

    await expect(
      main(["replay", "--trace", `00-${traceId}-${spanId}-01`], harness.context, [replayCommand]),
    ).resolves.toBe(ExitCode.ok);
    expect(harness.stdout.join("")).toContain(`root\t${rootRunId}`);
    expect(harness.stdout.join("")).toContain(`subagent\t${childRunId}`);
  });

  it.each([
    ["missing selectors", ["replay"]],
    ["both selectors", ["replay", "--run", rootRunId, "--trace", traceId]],
  ])("rejects %s as usage", async (_description, args) => {
    const harness = await createHarness(new Map());

    await expect(main(args, harness.context, [replayCommand])).resolves.toBe(ExitCode.usage);
    expect(harness.stderr).toEqual(["replay_input_invalid\n"]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("writes a metadata-only JSON document when requested", async () => {
    const harness = await createHarness(
      new Map([[rootRunId, [createdEvent(rootRunId), contentEvent(rootRunId)]]]),
    );

    await expect(
      main(["--json", "replay", "--run", rootRunId], harness.context, [replayCommand]),
    ).resolves.toBe(ExitCode.ok);
    expect(harness.stdout).toEqual([
      `{"rootRunId":"${rootRunId}","runs":[{"runId":"${rootRunId}","role":"root"}]}\n`,
    ]);
    expect(harness.stdout.join("")).not.toContain(contentCanary);
  });

  it("maps unknown runs to the not-found exit code", async () => {
    const harness = await createHarness(new Map());

    await expect(
      main(["replay", "--run", rootRunId], harness.context, [replayCommand]),
    ).resolves.toBe(ExitCode.failure);
    expect(harness.stderr).toEqual(["run_not_found\n"]);
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
