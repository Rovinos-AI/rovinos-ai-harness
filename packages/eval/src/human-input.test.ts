// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime, foldRunState, type Runtime } from "@rovinos/core";
import {
  EventSchema,
  FakeClock,
  Id,
  InputRequestSchema,
  SequentialIdGenerator,
  type Event,
  type InputRequest,
} from "@rovinos/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { SimulatedHuman } from "./human.js";
import { HumanScriptSchema } from "./schema.js";
import { prepareTrial } from "./executor.js";
import { TrialSpecSchema } from "./trial.js";

const runId = Id.parse("00000000000000000000000000");
const envelope = {
  runId,
  ts: 1,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: runId,
};
const form = {
  type: "object",
  properties: { confirmed: { type: "boolean" } },
  required: ["confirmed"],
};
const scratch = join(process.cwd(), "packages/eval/.test-input-unit");
const runtimes: Runtime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(scratch, { recursive: true, force: true });
});

function request(index: number, overrides: Partial<InputRequest> = {}): InputRequest {
  return InputRequestSchema.parse({
    requestId: Id.parse(String(index).padStart(26, "0")),
    callId: Id.parse("00000000000000000000000009"),
    inputKey: "confirmation",
    source: "agent",
    round: 1,
    mode: "form",
    schema: form,
    message: "Synthetic confirmation",
    ...overrides,
  });
}

async function pendingRuntime(requests: readonly InputRequest[]) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "trial-"));
  const task = {
    id: "synthetic_input",
    input: { goal: "Synthetic confirmation" },
    graders: [],
    tags: [],
  };
  const prepared = await prepareTrial(
    TrialSpecSchema.parse({
      suite: { schemaVersion: 1, tasks: [task] },
      task,
      variantId: "baseline",
      variant: { id: "baseline" },
      trialIndex: 0,
      seed: 1,
      workDir: join(directory, "run"),
    }),
    { randomBytes: (size) => new Uint8Array(size).fill(1) },
  );
  const runtime = await createRuntime(prepared.runtimeConfig, {
    dataDir: prepared.dataDir,
    transientVault: false,
    clock: new FakeClock(2),
    ids: new SequentialIdGenerator(),
    secretResolver: { resolve: () => Promise.resolve({ reveal: () => prepared.key }) },
  });
  runtimes.push(runtime);
  const { store } = runtime;
  const events = [
    EventSchema.parse({
      ...envelope,
      seq: 0,
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
      depth: 0,
    }),
    EventSchema.parse({
      ...envelope,
      seq: 1,
      type: "tool_intent",
      callId: Id.parse("00000000000000000000000009"),
      toolId: "sample.confirm",
      args: {},
      argsHash: "a".repeat(64),
      policyDecision: "allow",
      idempotent: true,
    }),
    ...requests.map((input, index) =>
      EventSchema.parse({ ...envelope, ...input, seq: index + 2, type: "input_requested" }),
    ),
  ];
  await store.append(runId, events, 0);
  async function read(): Promise<Event[]> {
    const recorded: Event[] = [];
    for await (const event of store.read(runId)) {
      recorded.push(event);
    }
    return recorded;
  }
  return { runtime, read };
}

describe("simulated durable human inputs", () => {
  it("uses the first matching source/server/mode rule and records action counts only", async () => {
    const { runtime, read } = await pendingRuntime([
      request(1, { source: "mcp_mrtr", serverId: "sample.server" }),
      request(2, { source: "mcp_legacy", serverId: "sample.server" }),
      request(3, { mode: "url", schema: undefined, url: "https://example.test/connect" }),
    ]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({
        rules: [],
        default: "deny",
        inputs: [
          { match: { serverId: "other.server" }, action: "cancel" },
          { match: { source: "agent", mode: "form" }, action: "cancel" },
          {
            match: { source: "mcp_mrtr", serverId: "sample.server", mode: "form" },
            action: "accept",
            answer: { confirmed: true },
          },
          { match: { source: "mcp_legacy" }, action: "cancel" },
          { match: { mode: "url" }, action: "accept" },
          { match: {}, action: "decline" },
        ],
      }),
      runtime,
    );
    expect(await human.hasPendingInputs(runId)).toBe(true);
    expect(await human.step(runId)).toBe(3);
    expect(human.inputCounts).toEqual({ accepted: 2, declined: 0, cancelled: 1 });
    expect(human.counts).toEqual({ approved: 0, denied: 0, edited: 0 });
    const resolutions = (await read()).filter((event) => event.type === "input_resolved");
    expect(resolutions.map(({ action }) => action)).toEqual(["accept", "cancel", "accept"]);
    expect(resolutions.every(({ approverId }) => approverId === "eval.simulated")).toBe(true);
    expect(await human.step(runId)).toBe(0);
    expect(await human.hasPendingInputs(runId)).toBe(false);
  });

  it("defaults inputs to decline even with explicit unsafe default approval", async () => {
    const { runtime, read } = await pendingRuntime([request(1)]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({ rules: [], default: "approve", unsafeAutoApprove: true }),
      runtime,
    );
    await expect(
      human.runUntilSettled(runId, "suspended", () => Promise.resolve("completed")),
    ).resolves.toEqual({ status: "completed", maxResumesExceeded: false });
    expect(human.inputCounts).toEqual({ accepted: 0, declined: 1, cancelled: 0 });
    expect((await read()).find((event) => event.type === "input_resolved")).toMatchObject({
      action: "decline",
    });
  });

  it("stores accepted sensitive answers as tokens and keeps counts content-free", async () => {
    const email = "synthetic-answer@example.test";
    const { runtime, read } = await pendingRuntime([
      request(1, {
        schema: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
      }),
    ]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({
        rules: [],
        default: "deny",
        inputs: [{ match: { source: "agent" }, action: "accept", answer: { email } }],
      }),
      runtime,
    );
    await human.step(runId);
    const events = await read();
    expect(events.find((event) => event.type === "input_resolved")).toMatchObject({
      answer: { email: "<EMAIL_1>" },
      approverId: "eval.simulated",
    });
    expect(JSON.stringify(events)).not.toContain(email);
    expect(human.inputCounts).toEqual({ accepted: 1, declined: 0, cancelled: 0 });
  });

  it("does not count an expired request as a successful scripted resolution", async () => {
    const { runtime, read } = await pendingRuntime([request(1, { expiresAt: 1 })]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({ rules: [], default: "deny" }),
      runtime,
    );
    await expect(human.step(runId)).rejects.toMatchObject({ code: "input_expired" });
    expect(human.inputCounts).toEqual({ accepted: 0, declined: 0, cancelled: 0 });
    expect((await read()).find((event) => event.type === "input_resolved")).toMatchObject({
      action: "cancel",
      decidedBy: "expiry",
    });
  });

  it.each([{ answer: { confirmed: "invalid" } }, {}])(
    "rejects invalid accepted form answers through real core validation: %j",
    async (answer) => {
      const { runtime, read } = await pendingRuntime([request(1)]);
      const human = new SimulatedHuman(
        HumanScriptSchema.parse({
          rules: [],
          default: "deny",
          inputs: [{ match: {}, action: "accept", ...answer }],
        }),
        runtime,
      );
      await expect(human.step(runId)).rejects.toMatchObject({ code: "input_answer_invalid" });
      expect(foldRunState(await read()).pendingInputs.size).toBe(1);
      expect(human.inputCounts).toEqual({ accepted: 0, declined: 0, cancelled: 0 });
    },
  );

  it("rejects URL answers through the real resolver without counting a success", async () => {
    const { runtime } = await pendingRuntime([
      request(1, { mode: "url", schema: undefined, url: "https://example.test/connect" }),
    ]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({
        rules: [],
        default: "deny",
        inputs: [{ match: {}, action: "accept", answer: { confirmed: true } }],
      }),
      runtime,
    );
    await expect(human.step(runId)).rejects.toMatchObject({ code: "input_answer_invalid" });
    expect(human.inputCounts.accepted).toBe(0);
  });

  it("bounds endless input rounds and leaves the next round unresolved", async () => {
    const { runtime, read } = await pendingRuntime([request(1)]);
    const human = new SimulatedHuman(
      HumanScriptSchema.parse({ rules: [], default: "deny", maxResumes: 1 }),
      runtime,
    );
    let resumes = 0;
    const result = await human.runUntilSettled(runId, "suspended", async () => {
      resumes += 1;
      const events = await read();
      await runtime.store.append(
        runId,
        [
          EventSchema.parse({
            ...envelope,
            ...request(2, { round: 2 }),
            seq: events.length,
            type: "input_requested",
          }),
        ],
        events.length,
      );
      return "suspended";
    });
    expect(result).toEqual({ status: "suspended", maxResumesExceeded: true });
    expect(resumes).toBe(1);
    expect(human.inputCounts.declined).toBe(1);
    expect(foldRunState(await read()).pendingInputs.size).toBe(1);
  });

  it("preserves approval safety and rejects malformed input scripts", () => {
    expect(HumanScriptSchema.safeParse({ rules: [], default: "approve", inputs: [] }).success).toBe(
      false,
    );
    for (const rule of [
      { match: { source: "model" }, action: "accept" },
      { match: {}, action: "approve" },
      { match: {}, action: "cancel", answer: {} },
      { match: { message: "instructions" }, action: "accept" },
    ]) {
      expect(
        HumanScriptSchema.safeParse({ rules: [], default: "deny", inputs: [rule] }).success,
      ).toBe(false);
    }
  });

  it("fails closed if an approval-only runtime encounters a pending input", async () => {
    const { runtime } = await pendingRuntime([request(1)]);
    const human = new SimulatedHuman(HumanScriptSchema.parse({ rules: [], default: "deny" }), {
      store: runtime.store,
      resolveApproval: (...args) => runtime.resolveApproval(...args),
    });
    await expect(human.step(runId)).rejects.toMatchObject({
      code: "human_input_runtime_unavailable",
    });
    expect(human.inputCounts).toEqual({ accepted: 0, declined: 0, cancelled: 0 });
  });
});
