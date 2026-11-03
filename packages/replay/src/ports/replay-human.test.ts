// SPDX-License-Identifier: Apache-2.0
import { Event as EventSchema, Id, type Event } from "@rovinos/schemas";
import { ResolvedRunSchema } from "../resolve.js";
import { describe, expect, it, vi } from "vitest";
import { ReplayApprovalMissingError, ReplayHuman } from "./replay-human.js";
import { recordInputRun } from "../input-fixture.js";
import { InMemoryEventStore } from "@rovinos/store";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const callId = Id.parse("00000000000000000000000003");
const approvalId = Id.parse("00000000000000000000000004");

function resolved(): { readonly events: readonly Event[]; readonly resolution: Event } {
  const envelope = {
    runId,
    ts: 1,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
  };
  const events = [
    EventSchema.parse({
      ...envelope,
      seq: 0,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
    }),
    EventSchema.parse({
      ...envelope,
      seq: 1,
      type: "approval_requested",
      approvalId,
      callId,
      payload: {},
    }),
  ];
  const resolution = EventSchema.parse({
    ...envelope,
    seq: 2,
    type: "approval_resolved",
    approvalId,
    decision: "edit",
    decidedBy: "human",
    approverId: "cli.replay",
    reason: "approved",
    edits: { query: "updated synthetic" },
    waitMs: 1,
  });
  events.push(resolution);
  const replay = ResolvedRunSchema.parse({
    rootRunId: runId,
    runs: [{ runId, role: "root", events }],
  });
  return { events: replay.runs[0]?.events ?? [], resolution };
}

describe("ReplayHuman", () => {
  it("resolves all recorded inputs before resuming and preserves tokenized answers", async () => {
    const { resolved: recording } = await recordInputRun({ batch: true, rounds: 1 });
    const events = recording.runs[0]?.events ?? [];
    const requests = events.filter((event) => event.type === "input_requested");
    const human = new ReplayHuman(recording);
    const runtime = {
      resolveInput: vi.fn(() => Promise.resolve(undefined)),
      resume: vi.fn(() => Promise.resolve(undefined)),
      store: new InMemoryEventStore(),
      clock: { now: () => 1 },
    };
    await human.resolveInputsAndResume(runtime, recording.rootRunId, requests);
    expect(runtime.resolveInput).toHaveBeenCalledTimes(2);
    expect(runtime.resolveInput).toHaveBeenNthCalledWith(
      1,
      recording.rootRunId,
      requests[0]?.requestId,
      { action: "accept", answer: { email: "<EMAIL_1>" }, principal: "cli.synthetic" },
    );
    expect(runtime.resume.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtime.resolveInput.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects a changed requestState before resolving an input", async () => {
    const { resolved: recording } = await recordInputRun({ rounds: 1 });
    const request = recording.runs[0]?.events.find((event) => event.type === "input_requested");
    if (request?.type !== "input_requested") {
      throw new Error("Expected a synthetic recorded input.");
    }
    const runtime = {
      resolveInput: vi.fn(() => Promise.resolve(undefined)),
      resume: vi.fn(() => Promise.resolve(undefined)),
      store: new InMemoryEventStore(),
      clock: { now: () => 1 },
    };
    await expect(
      new ReplayHuman(recording).resolveInputsAndResume(runtime, recording.rootRunId, [
        { ...request, requestState: "changed.synthetic.state" },
      ]),
    ).rejects.toMatchObject({ code: "replay_divergence" });
    expect(runtime.resolveInput).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
  });

  it("resolves and resumes through the runtime approval path with recorded edits", async () => {
    const { events, resolution } = resolved();
    const human = new ReplayHuman(
      ResolvedRunSchema.parse({
        rootRunId: runId,
        runs: [{ runId, role: "root", events }],
      }),
    );
    const runtime = {
      resolveApproval: vi.fn(() => Promise.resolve(resolution)),
      resume: vi.fn(() => Promise.resolve(undefined)),
    };

    await human.resolveAndResume(runtime, runId, callId);

    expect(runtime.resolveApproval).toHaveBeenCalledWith(runId, approvalId, "edit", {
      edits: { query: "updated synthetic" },
      metadata: { decidedBy: "human", approverId: "cli.replay", reason: "approved" },
    });
    expect(runtime.resolveApproval.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.resume.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runtime.resume).toHaveBeenCalledWith(runId);
  });

  it("fails with a closed missing-result code when no approval was recorded", async () => {
    const human = new ReplayHuman(
      ResolvedRunSchema.parse({ rootRunId: runId, runs: [{ runId, role: "root", events: [] }] }),
    );
    const runtime = {
      resolveApproval: vi.fn(() => Promise.resolve(undefined)),
      resume: vi.fn(() => Promise.resolve(undefined)),
    };

    await expect(human.resolveAndResume(runtime, runId, callId)).rejects.toBeInstanceOf(
      ReplayApprovalMissingError,
    );
    expect(runtime.resolveApproval).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
  });
});
