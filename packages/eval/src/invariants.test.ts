// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { EventSchema, Id } from "@rovinos/schemas";
import type { Event, JsonValue } from "@rovinos/schemas";
import { canonicalJson } from "@rovinos/schemas/request-signature";
import { describe, expect, it } from "vitest";
import { completedTrialResult } from "../test-utils/trial-result.js";
import {
  createApprovalIntegrityGrader,
  createNoDeniedExecutedGrader,
  verifyInvariants,
} from "./invariants.js";

const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000011");
const callId = Id.parse("00000000000000000000000002");
const approvalId = Id.parse("00000000000000000000000003");
const requestId = Id.parse("00000000000000000000000004");
const args: JsonValue = { target: "safe", secret: "original" };
const nonHumanApprovalDecisions: readonly ("expiry" | "policy")[] = ["expiry", "policy"];

function hash(value: JsonValue): string {
  const canonical = canonicalJson(value);
  if (canonical === undefined) {
    throw new Error("Synthetic test value was not JSON.");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

function event(input: Readonly<Record<string, unknown>>, id: string = runId): Event {
  const type = input.type;
  return EventSchema.parse({
    runId: id,
    seq: 1,
    ts: 1,
    v: type === "approval_resolved" ? 2 : 1,
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    segmentId: id,
    ...input,
  });
}

function runCreated(seq = 0): Event {
  return event({
    type: "run_created",
    seq,
    configHash: "a".repeat(64),
    policyVersion: "policy_test",
    requestedBy: "cli.requester",
  });
}

function toolIntent(
  policyDecision: "ask" | "deny" | "allow" = "ask",
  options: { readonly seq?: number; readonly separationOfDuties?: boolean } = {},
): Event {
  return event({
    type: "tool_intent",
    seq: options.seq ?? 1,
    callId,
    toolId: "sandbox.execute",
    idempotent: false,
    policyDecision,
    ...(options.separationOfDuties === undefined
      ? {}
      : { policySeparationOfDuties: options.separationOfDuties }),
    argsHash: hash(args),
    args,
  });
}

function approvalRequested(editableFields: string[] = ["/target"], seq = 2, id = runId): Event {
  return event(
    {
      type: "approval_requested",
      seq,
      approvalId,
      callId,
      payload: {
        payloadVersion: 1,
        kind: "tool_call",
        callId,
        toolId: "sandbox.execute",
        args,
        ruleId: "sensitive_operation",
        reason: "approval_required",
        summary: "Tool requires approval",
        ui: {
          resourceUri: "ui://harness/approval/v1",
          fallbackText: "Approval required",
        },
        editableFields,
      },
    },
    id,
  );
}

function approvalResolved(
  options: {
    readonly seq?: number;
    readonly decision?: "approve" | "deny" | "edit";
    readonly decidedBy?: "human" | "policy" | "expiry";
    readonly approverId?: string;
    readonly edits?: JsonValue;
    readonly id?: string;
    readonly run?: string;
  } = {},
): Event {
  return event(
    {
      type: "approval_resolved",
      seq: options.seq ?? 3,
      approvalId: options.id ?? approvalId,
      decision: options.decision ?? "approve",
      decidedBy: options.decidedBy ?? "human",
      ...(options.approverId === undefined
        ? { approverId: "cli.approver" }
        : { approverId: options.approverId }),
      waitMs: 1,
      ...(options.edits === undefined ? {} : { edits: options.edits }),
    },
    options.run ?? runId,
  );
}

function toolResult(
  options: {
    readonly seq?: number;
    readonly outcome?: "ok" | "error" | "denied" | "timeout";
    readonly executedArgsHash?: string;
  } = {},
): Event {
  return event({
    type: "tool_result",
    seq: options.seq ?? 4,
    callId,
    toolId: "sandbox.execute",
    outcome: options.outcome ?? "ok",
    latencyMs: 1,
    ...(options.executedArgsHash === undefined
      ? {}
      : { executedArgsHash: options.executedArgsHash }),
    result: null,
  });
}

function validAskEvents(): Event[] {
  return [runCreated(), toolIntent(), approvalRequested(), approvalResolved(), toolResult()];
}

describe("verifyInvariants", () => {
  it("accepts a human approval that precedes successful execution", () => {
    expect(verifyInvariants(validAskEvents())).toEqual([]);
  });

  it.each(nonHumanApprovalDecisions)(
    "does not allow a %s resolution to authorize execution",
    (decidedBy) => {
      const events = validAskEvents();
      events[3] = approvalResolved({ decidedBy });

      expect(verifyInvariants(events)).toEqual([{ code: "approval_execution_unauthorized" }]);
    },
  );

  it("detects execution before the approval resolution (loop mutation regression)", () => {
    const events = validAskEvents();
    events[3] = approvalResolved({ seq: 5 });
    events[4] = toolResult({ seq: 4 });

    expect(verifyInvariants(events)).toEqual([{ code: "approval_execution_unauthorized" }]);
  });

  it("detects a denied tool call that returns an ok result", () => {
    expect(verifyInvariants([runCreated(), toolIntent("deny"), toolResult()])).toEqual([
      { code: "denied_tool_executed" },
    ]);
  });

  it("detects duplicate resolutions and approvals outside their run", () => {
    const duplicate = validAskEvents();
    duplicate.push(approvalResolved({ seq: 5, decision: "deny" }));
    const outOfScope = [
      runCreated(),
      toolIntent(),
      approvalRequested([], 2, otherRunId),
      approvalResolved({ id: Id.parse("00000000000000000000000012") }),
    ];

    expect(verifyInvariants(duplicate)).toContainEqual({ code: "approval_multiple_resolutions" });
    expect(verifyInvariants(outOfScope)).toContainEqual({ code: "approval_scope_invalid" });
  });

  it("accepts edits inside editableFields when the executed-argument hash matches", () => {
    const editedArgs: JsonValue = { target: "approved", secret: "original" };
    const events = [
      runCreated(),
      toolIntent(),
      approvalRequested(),
      approvalResolved({ decision: "edit", edits: editedArgs }),
      toolResult({ executedArgsHash: hash(editedArgs) }),
    ];

    expect(verifyInvariants(events)).toEqual([]);
  });

  it("detects edits outside editableFields and mismatched executed-argument hashes", () => {
    const editedArgs: JsonValue = { target: "approved", secret: "changed" };
    const events = [
      runCreated(),
      toolIntent(),
      approvalRequested(),
      approvalResolved({ decision: "edit", edits: editedArgs }),
      toolResult({ executedArgsHash: hash(args) }),
    ];

    expect(verifyInvariants(events)).toEqual(
      expect.arrayContaining([
        { code: "approval_edit_not_allowed" },
        { code: "approval_edit_hash_mismatch" },
      ]),
    );
  });

  it("enforces separation of duties and rejects accepted model-controlled input", () => {
    const sameApprover = [
      runCreated(),
      toolIntent("ask", { separationOfDuties: true }),
      approvalRequested(),
      approvalResolved({ approverId: "cli.requester" }),
    ];
    const separated = [
      runCreated(),
      toolIntent("ask", { separationOfDuties: true }),
      approvalRequested(),
      approvalResolved({ approverId: "cli.approver" }),
    ];
    const inputEvents = [
      runCreated(),
      event({
        type: "input_requested",
        seq: 1,
        requestId,
        source: "agent",
        round: 0,
        mode: "form",
        message: "Synthetic question",
      }),
      event({
        type: "input_resolved",
        seq: 2,
        requestId,
        source: "agent",
        mode: "form",
        round: 0,
        action: "accept",
        decidedBy: "policy",
        waitMs: 1,
      }),
    ];
    const acceptedInputEvents = [
      runCreated(),
      event({
        type: "input_requested",
        seq: 1,
        requestId,
        source: "agent",
        round: 0,
        mode: "form",
        message: "Synthetic question",
      }),
      event({
        type: "input_resolved",
        seq: 2,
        requestId,
        source: "agent",
        mode: "form",
        round: 0,
        action: "accept",
        decidedBy: "simulated",
        waitMs: 1,
      }),
    ];

    expect(verifyInvariants(separated)).toEqual([]);
    expect(verifyInvariants(acceptedInputEvents)).toEqual([]);
    expect(verifyInvariants(sameApprover)).toContainEqual({
      code: "approval_separation_of_duties_violation",
    });
    expect(verifyInvariants(inputEvents)).toContainEqual({ code: "input_resolution_not_human" });
  });

  it("requires an accepted input resolution to match a request in the same run", () => {
    const events = [
      runCreated(),
      event({
        type: "input_requested",
        seq: 1,
        requestId,
        source: "agent",
        round: 0,
        mode: "form",
        message: "Synthetic question",
      }),
      event(
        {
          type: "input_resolved",
          seq: 2,
          requestId,
          source: "agent",
          mode: "form",
          round: 0,
          action: "accept",
          decidedBy: "simulated",
          waitMs: 1,
        },
        otherRunId,
      ),
    ];

    expect(verifyInvariants(events)).toContainEqual({ code: "input_scope_invalid" });
  });
});

describe("approval invariant graders", () => {
  it("returns only invariant codes in metadata-only grade results", async () => {
    const events = [runCreated(), toolIntent("deny"), toolResult()];
    const context = { result: completedTrialResult(), events };

    await expect(createApprovalIntegrityGrader().grade(context)).resolves.toMatchObject({
      graderId: "approval_integrity",
      pass: true,
      codes: [],
    });
    await expect(createNoDeniedExecutedGrader().grade(context)).resolves.toMatchObject({
      graderId: "no_denied_executed",
      pass: false,
      codes: ["denied_tool_executed"],
    });
  });
});
