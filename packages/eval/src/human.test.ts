// SPDX-License-Identifier: Apache-2.0
import { Id, EventSchema } from "@rovinos/schemas";
import type { Event, JsonValue } from "@rovinos/schemas";
import type { Runtime } from "@rovinos/core";
import { describe, expect, it } from "vitest";
import { SimulatedHuman, SimulatedHumanError } from "./human.js";

const runId = Id.parse("00000000000000000000000000");
const envelope = {
  runId,
  ts: 1,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: runId,
};

interface Resolution {
  readonly approvalId: Id;
  readonly decision: "approve" | "deny" | "edit";
  readonly options: Parameters<Runtime["resolveApproval"]>[3];
}

function createRuntime(approvalPayloads: readonly JsonValue[]) {
  const events: Event[] = [
    EventSchema.parse({
      ...envelope,
      seq: 0,
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
      depth: 0,
    }),
    ...approvalPayloads.map((approvalPayload, index) =>
      EventSchema.parse({
        ...envelope,
        seq: index + 1,
        type: "approval_requested",
        approvalId: Id.parse(String(index + 1).padStart(26, "0")),
        callId: Id.parse(String(index + 1).padStart(26, "0")),
        payload: approvalPayload,
      }),
    ),
  ];
  const resolutions: Resolution[] = [];
  const runtime = {
    store: {
      async *read(requestedRunId: Id): AsyncGenerator<Event> {
        await Promise.resolve();
        if (requestedRunId === runId) {
          yield* events;
        }
      },
    },
    resolveApproval: (
      requestedRunId: Id,
      approvalId: Id,
      decision: Resolution["decision"],
      options: Resolution["options"],
    ) => {
      resolutions.push({ approvalId, decision, options });
      const event = EventSchema.parse({
        ...envelope,
        runId: requestedRunId,
        seq: events.length,
        type: "approval_resolved",
        approvalId,
        decision,
        decidedBy: "human",
        approverId: "eval.simulated",
        waitMs: 0,
        ...(options?.edits === undefined ? {} : { edits: options.edits }),
      });
      if (event.type !== "approval_resolved") {
        throw new Error("synthetic_resolution_invalid");
      }
      return Promise.resolve(event);
    },
  } satisfies Pick<Runtime, "resolveApproval"> & {
    readonly store: Pick<Runtime["store"], "read">;
  };
  return { runtime, resolutions };
}

function payload(toolId: string, args: JsonValue, ruleId = "test.rule"): JsonValue {
  return {
    payloadVersion: 1,
    kind: "tool_call",
    callId: "00000000000000000000000001",
    toolId,
    args,
    ruleId,
    reason: "approval_required",
    summary: "Synthetic approval",
    ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Synthetic approval" },
    editableFields: ["/value"],
  };
}

describe("SimulatedHuman", () => {
  it("uses the first matching rule and resolves edits with runtime metadata", async () => {
    const approvalPayload = payload("mail.send", {
      value: "before",
      nested: { "a/b": { "~key": [{ count: 2 }] } },
    });
    const { runtime, resolutions } = createRuntime([approvalPayload]);
    const human = new SimulatedHuman(
      {
        rules: [
          { match: { toolId: "wrong.tool" }, decision: "deny" },
          { match: { ruleId: "wrong.rule" }, decision: "deny" },
          {
            match: {
              pointerEquals: {
                pointer: "/nested/a~1b/~0key",
                value: [{ count: 2 }],
              },
            },
            decision: "edit",
            edits: [{ pointer: "/value", value: "after" }],
          },
        ],
        default: "deny",
        maxResumes: 10,
      },
      runtime,
    );

    expect(await human.hasPendingApprovals(runId)).toBe(true);
    expect(await human.step(runId)).toBe(1);
    expect(resolutions).toMatchObject([
      {
        decision: "edit",
        options: {
          edits: { value: "after", nested: { "a/b": { "~key": [{ count: 2 }] } } },
          metadata: { decidedBy: "human", approverId: "eval.simulated" },
        },
      },
    ]);
    expect(human.counts).toEqual({ approved: 0, denied: 0, edited: 1 });
  });

  it("compares token types without exposing token values and rejects invalid pointers", async () => {
    const { runtime, resolutions } = createRuntime([
      payload("mail.send", { value: "<EMAIL_1>" }),
      payload("phone.send", { value: "<PHONE_2>" }),
      payload("array.read", { values: ["zero", "one"] }),
      payload("nested.read", { value: "plain" }),
    ]);
    const human = new SimulatedHuman(
      {
        rules: [
          {
            match: { toolId: "mail.send", pointerEquals: { pointer: "/value", value: "email" } },
            decision: "approve",
          },
          {
            match: { toolId: "phone.send", pointerEquals: { pointer: "/value", value: 3 } },
            decision: "approve",
          },
          {
            match: { toolId: "array.read", pointerEquals: { pointer: "/values/01", value: "one" } },
            decision: "approve",
          },
          {
            match: {
              toolId: "nested.read",
              pointerEquals: { pointer: "/value/missing", value: 1 },
            },
            decision: "approve",
          },
        ],
        default: "deny",
        maxResumes: 10,
      },
      runtime,
    );

    await human.step(runId);

    expect(resolutions.map(({ decision }) => decision)).toEqual([
      "approve",
      "deny",
      "deny",
      "deny",
    ]);
    expect(human.counts).toEqual({ approved: 1, denied: 3, edited: 0 });
  });

  it("rejects malformed pending payloads with a coded error", async () => {
    const { runtime } = createRuntime([null]);
    const human = new SimulatedHuman({ rules: [], default: "deny", maxResumes: 10 }, runtime);

    await expect(human.step(runId)).rejects.toBeInstanceOf(SimulatedHumanError);
    await expect(human.step(runId)).rejects.toMatchObject({
      code: "human_approval_payload_invalid",
    });
  });

  it("stops at the resume limit and leaves terminal runs untouched", async () => {
    const { runtime } = createRuntime([payload("mail.send", { value: "synthetic" })]);
    const human = new SimulatedHuman({ rules: [], default: "deny", maxResumes: 1 }, runtime);
    const resumes: number[] = [];
    const exhausted = await human.runUntilSettled(runId, "suspended", () => {
      resumes.push(1);
      return Promise.resolve("suspended");
    });

    expect(exhausted).toEqual({ status: "suspended", maxResumesExceeded: true });
    expect(resumes).toHaveLength(1);

    const empty = createRuntime([]);
    const idleHuman = new SimulatedHuman(
      { rules: [], default: "deny", maxResumes: 10 },
      empty.runtime,
    );
    expect(await idleHuman.hasPendingApprovals(runId)).toBe(false);
    await expect(
      idleHuman.runUntilSettled(runId, "completed", () =>
        Promise.reject(new Error("terminal_run_resumed")),
      ),
    ).resolves.toEqual({ status: "completed", maxResumesExceeded: false });
  });
});
