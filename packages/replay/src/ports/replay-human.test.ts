// SPDX-License-Identifier: Apache-2.0
import { Event as EventSchema, Id, type Event } from "@rovinos/schemas";
import { ResolvedRunSchema } from "../resolve.js";
import { describe, expect, it, vi } from "vitest";
import { ReplayApprovalMissingError, ReplayHuman } from "./replay-human.js";

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
