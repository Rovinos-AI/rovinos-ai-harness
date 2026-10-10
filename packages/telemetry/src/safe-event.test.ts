// SPDX-License-Identifier: Apache-2.0
import { Event } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { SafeEvent, safeEventSchemas, toSafeEvent } from "./safe-event.js";
import { z } from "zod";

const envelope = {
  runId: "00000000000000000000000001",
  seq: 1,
  ts: 2,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: "00000000000000000000000001",
};

function validEvent(value: Record<string, unknown>): Event {
  return Event.parse({ ...envelope, ...value });
}

const mappedEvents: { event: Event; kind: string; fields: Record<string, unknown> }[] = [
  {
    event: validEvent({
      type: "model_response",
      requestId: "00000000000000000000000002",
      provider: "provider.test",
      model: "model.test",
      inputTokens: 1,
      outputTokens: 2,
      finishReason: "stop",
      latencyMs: 3,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      content: [{ type: "text", text: "MODEL_CONTENT_CANARY" }],
      providerBlobs: "MODEL_BLOB_CANARY",
    }),
    kind: "model_call",
    fields: {
      provider: "provider.test",
      model: "model.test",
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
      schemaValid: true,
      repairAttempts: 0,
      finishReason: "stop",
    },
  },
  {
    event: validEvent({
      type: "tool_result",
      callId: "00000000000000000000000002",
      toolId: "tool.test",
      outcome: "error",
      errorCode: "tool.failed",
      latencyMs: 4,
      result: "TOOL_CONTENT_CANARY",
    }),
    kind: "tool_call",
    fields: {
      toolId: "tool.test",
      outcome: "error",
      errorCode: "tool.failed",
      latencyMs: 4,
    },
  },
  {
    event: validEvent({
      type: "approval_resolved",
      approvalId: "00000000000000000000000002",
      decision: "approve",
      waitMs: 5,
      edits: "APPROVAL_CONTENT_CANARY",
    }),
    kind: "approval_wait",
    fields: { decision: "approve", waitMs: 5 },
  },
  {
    event: validEvent({
      type: "checkpoint_written",
      checkpointId: "00000000000000000000000002",
      atSeq: 6,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      workspaceRef: "workspace.ref",
    }),
    kind: "checkpoint",
    fields: { atSeq: 6, hasWorkspaceRef: true },
  },
  {
    event: validEvent({
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "run.started",
    }),
    kind: "run_status",
    fields: { from: "pending", to: "running", reason: "run.started" },
  },
  {
    event: validEvent({
      type: "pii_action",
      boundary: "tool_input",
      action: "tokenized",
      entities: [{ type: "email", count: 1 }],
    }),
    kind: "pii_action",
    fields: {
      boundary: "tool_input",
      action: "tokenized",
      entities: [{ type: "email", count: 1 }],
    },
  },
  {
    event: validEvent({
      type: "budget_exceeded",
      budget: "steps",
      limit: 10,
      observed: 11,
    }),
    kind: "budget_exceeded",
    fields: { budget: "steps", limit: 10, observed: 11 },
  },
  {
    event: validEvent({
      type: "subagent_spawned",
      childRunId: "00000000000000000000000002",
      role: "reviewer",
      parentCallId: "00000000000000000000000003",
    }),
    kind: "subagent_spawned",
    fields: {
      childRunId: "00000000000000000000000002",
      role: "reviewer",
      parentCallId: "00000000000000000000000003",
    },
  },
  {
    event: validEvent({
      type: "subagent_completed",
      childRunId: "00000000000000000000000002",
      outcome: "completed",
    }),
    kind: "subagent_completed",
    fields: {
      childRunId: "00000000000000000000000002",
      outcome: "completed",
    },
  },
  {
    event: validEvent({
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "run.policy.v1",
    }),
    kind: "run_created",
    fields: { configHash: "c".repeat(64) },
  },
];

const unexportedEvents = [
  validEvent({
    type: "model_request",
    requestId: "00000000000000000000000002",
    provider: "provider.test",
    model: "model.test",
    messages: [{ role: "user", parts: [{ type: "text", text: "MODEL_REQUEST_CANARY" }] }],
  }),
  validEvent({
    type: "tool_intent",
    callId: "00000000000000000000000002",
    toolId: "tool.test",
    idempotent: true,
    policyDecision: "allow",
    argsHash: "c".repeat(64),
    args: "TOOL_INTENT_CANARY",
  }),
  validEvent({
    type: "approval_requested",
    approvalId: "00000000000000000000000002",
    callId: "00000000000000000000000002",
    payload: "APPROVAL_REQUEST_CANARY",
  }),
  validEvent({
    type: "context_compacted",
    fromSeq: 1,
    toSeq: 2,
    strategy: "summary",
    strategyVersion: "summary.v1",
    summary: "CONTEXT_CANARY",
  }),
];

function assertConstrainedStrings(schema: z.core.$ZodType): void {
  if (schema instanceof z.ZodString) {
    expect(schema._zod.def.checks?.length ?? 0).toBeGreaterThan(0);
  } else if (schema instanceof z.ZodObject) {
    Object.values(schema.shape).forEach(assertConstrainedStrings);
  } else if (schema instanceof z.ZodArray) {
    assertConstrainedStrings(schema.element);
  } else if (schema instanceof z.ZodOptional) {
    assertConstrainedStrings(schema.unwrap());
  }
}

describe("SafeEvent projection", () => {
  it.each(mappedEvents)(
    "maps $event.type to $kind with the current policy version",
    ({ event, kind, fields }) => {
      expect(toSafeEvent(event, "sanitizer.v1")).toEqual({
        runId: envelope.runId,
        seq: event.seq,
        ts: event.ts,
        traceId: event.traceId,
        spanId: event.spanId,
        policyVersion: "sanitizer.v1",
        kind,
        ...fields,
      });
    },
  );

  it.each(unexportedEvents)("does not export $type", (event) => {
    expect(toSafeEvent(event, "sanitizer.v1")).toBeNull();
  });

  it("omits optional metadata fields when absent", () => {
    const noErrorCode = validEvent({
      type: "tool_result",
      callId: "00000000000000000000000002",
      toolId: "tool.test",
      outcome: "ok",
      latencyMs: 4,
      result: {},
    });
    const noWorkspaceRef = validEvent({
      type: "checkpoint_written",
      checkpointId: "00000000000000000000000002",
      atSeq: 6,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    });
    const noParentCallId = validEvent({
      type: "subagent_spawned",
      childRunId: "00000000000000000000000002",
      role: "reviewer",
    });

    expect(toSafeEvent(noErrorCode, "sanitizer.v1")).not.toHaveProperty("errorCode");
    expect(toSafeEvent(noWorkspaceRef, "sanitizer.v1")).toMatchObject({
      kind: "checkpoint",
      hasWorkspaceRef: false,
    });
    expect(toSafeEvent(noParentCallId, "sanitizer.v1")).not.toHaveProperty("parentCallId");
  });

  it("never exports canary strings from randomized content fields", () => {
    let state = 0x13579bdf;
    const nextCanary = (): string => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return `CANARY_${state.toString(16)}`;
    };
    for (let index = 0; index < 100; index += 1) {
      const canary = nextCanary();
      const events = [
        validEvent({
          type: "model_response",
          requestId: "00000000000000000000000002",
          provider: "provider.test",
          model: "model.test",
          inputTokens: index,
          outputTokens: index,
          finishReason: "stop",
          latencyMs: index,
          schemaValid: true,
          repairAttempts: 0,
          content: [{ type: "text", text: canary }],
          providerBlobs: { canary },
        }),
        validEvent({
          type: "tool_result",
          callId: "00000000000000000000000002",
          toolId: "tool.test",
          outcome: "ok",
          latencyMs: index,
          result: { canary },
        }),
        validEvent({
          type: "approval_resolved",
          approvalId: "00000000000000000000000002",
          decision: "approve",
          waitMs: index,
          edits: { canary },
        }),
      ];
      for (const event of events) {
        expect(JSON.stringify(toSafeEvent(event, "sanitizer.v1"))).not.toContain(canary);
      }
    }
  });

  it("keeps every safe-event string field constrained and rejects unknown fields", () => {
    safeEventSchemas.forEach(assertConstrainedStrings);
    expect(() => {
      assertConstrainedStrings(z.string());
    }).toThrow();
    const modelResponse = mappedEvents.find(({ event }) => event.type === "model_response");
    if (modelResponse === undefined) {
      throw new Error("The model response mapping is missing");
    }
    expect(
      SafeEvent.safeParse({
        ...toSafeEvent(modelResponse.event, "sanitizer.v1"),
        unexpected: "UNSAFE_CANARY",
      }).success,
    ).toBe(false);
  });
});
