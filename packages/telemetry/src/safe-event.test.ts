// SPDX-License-Identifier: Apache-2.0
import { EVENT_FIELD_CLASS, Event, Pseudonym, eventSamples } from "@harness/schemas";
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

function canaryValue(value: unknown, canary: string): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [canary] : value.map((item) => canaryValue(item, canary));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0
      ? { canary }
      : Object.fromEntries(
          entries.map(([key, nested]) => [
            key,
            key === "role" || key === "type" || key === "format"
              ? nested
              : canaryValue(nested, canary),
          ]),
        );
  }
  return canary;
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
      type: "tool_intent",
      callId: "00000000000000000000000002",
      toolId: "tool.test",
      idempotent: true,
      policyDecision: "allow",
      ruleId: "policy.rule",
      policyReason: "policy.reason",
      argsHash: "c".repeat(64),
      args: { description: "POLICY_DESCRIPTION_CANARY" },
    }),
    kind: "policy_decision",
    fields: {
      toolId: "tool.test",
      policyDecision: "allow",
      ruleId: "policy.rule",
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
      decision: "deny",
      decidedBy: "expiry",
      reason: "expired",
      waitMs: 5,
      edits: "APPROVAL_CONTENT_CANARY",
    }),
    kind: "approval_wait",
    fields: { decision: "deny", decidedBy: "expiry", reason: "expired", waitMs: 5 },
  },
  {
    event: validEvent({
      type: "input_resolved",
      requestId: "00000000000000000000000002",
      source: "mcp_mrtr",
      mode: "form",
      round: 1,
      action: "accept",
      decidedBy: "human",
      approverId: "cli.approver",
      waitMs: 12,
      answer: { email: "INPUT_ANSWER_CANARY" },
    }),
    kind: "input_wait",
    fields: {
      source: "mcp_mrtr",
      mode: "form",
      round: 1,
      action: "accept",
      decidedBy: "human",
      waitMs: 12,
    },
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
      boundary: "ui",
      action: "detokenized",
      toolId: "mail.send",
      entities: [{ type: "email", count: 1 }],
    }),
    kind: "pii_action",
    fields: {
      boundary: "ui",
      action: "detokenized",
      toolId: "mail.send",
      entities: [{ type: "email", count: 1 }],
    },
  },
  {
    event: validEvent({
      type: "pii_action",
      boundary: "telemetry_export",
      action: "blocked",
      entities: [{ type: "email", count: 2 }],
    }),
    kind: "pii_action",
    fields: {
      boundary: "telemetry_export",
      action: "blocked",
      entities: [{ type: "email", count: 2 }],
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
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 3,
    }),
    kind: "subagent_completed",
    fields: {
      childRunId: "00000000000000000000000002",
      outcome: "completed",
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 3,
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
    type: "run_input",
    input: "RUN_INPUT_CANARY",
    inputKind: "initial",
  }),
  validEvent({
    type: "tool_execution_started",
    callId: "00000000000000000000000002",
    toolId: "tool.test",
  }),
  validEvent({
    type: "approval_requested",
    approvalId: "00000000000000000000000002",
    callId: "00000000000000000000000002",
    payload: "APPROVAL_REQUEST_CANARY",
  }),
  validEvent({
    type: "input_requested",
    requestId: "00000000000000000000000002",
    source: "mcp_mrtr",
    round: 1,
    mode: "form",
    message: "INPUT_MESSAGE_CANARY",
  }),
  validEvent({
    type: "context_compacted",
    fromSeq: 1,
    toSeq: 2,
    strategy: "summary",
    strategyVersion: "summary.v1",
    summary: "CONTEXT_CANARY",
  }),
  validEvent({
    type: "app_content",
    source: "app",
    appId: "approval.app",
    label: "App-provided; untrusted",
    kind: "message",
    content: { text: "APP_CONTENT_CANARY" },
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
    const noRuleIdIntent = validEvent({
      type: "tool_intent",
      callId: "00000000000000000000000002",
      toolId: "tool.test",
      idempotent: true,
      policyDecision: "allow",
      argsHash: "c".repeat(64),
      args: {},
    });

    expect(toSafeEvent(noErrorCode, "sanitizer.v1")).not.toHaveProperty("errorCode");
    expect(toSafeEvent(noWorkspaceRef, "sanitizer.v1")).toMatchObject({
      kind: "checkpoint",
      hasWorkspaceRef: false,
    });
    expect(toSafeEvent(noParentCallId, "sanitizer.v1")).not.toHaveProperty("parentCallId");
    expect(toSafeEvent(noRuleIdIntent, "sanitizer.v1")).not.toHaveProperty("ruleId");
  });

  it("omits raw principals by default and accepts only explicit pseudonyms", () => {
    const runCreated = validEvent({
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "run.policy.v1",
      requestedBy: "cli.requester",
    });
    const approvalResolved = validEvent({
      type: "approval_resolved",
      approvalId: "00000000000000000000000002",
      decision: "approve",
      decidedBy: "human",
      approverId: "cli.approver",
      waitMs: 5,
    });
    const requestedByPseudonym = Pseudonym.parse(`p_${"a".repeat(26)}`);
    const approverPseudonym = Pseudonym.parse(`p_${"b".repeat(26)}`);

    expect(JSON.stringify(toSafeEvent(runCreated, "sanitizer.v1"))).not.toContain("cli.requester");
    expect(JSON.stringify(toSafeEvent(approvalResolved, "sanitizer.v1"))).not.toContain(
      "cli.approver",
    );
    expect(
      toSafeEvent(runCreated, "sanitizer.v1", { requestedBy: requestedByPseudonym }),
    ).toMatchObject({ requestedByPseudonym });
    expect(
      toSafeEvent(approvalResolved, "sanitizer.v1", { approverId: approverPseudonym }),
    ).toMatchObject({ approverPseudonym });
  });

  it("never exports canaries from any classified content field", () => {
    for (const [index, sample] of eventSamples.entries()) {
      const canary = `CANARY_${sample.type}_${index.toString()}`;
      const contentFields = Object.entries(EVENT_FIELD_CLASS[sample.type])
        .filter(([, classification]) => classification === "content")
        .map(([field]) => field);
      const injected = Object.fromEntries(
        contentFields.map((field) => {
          const baseValue = Object.entries(sample).find(([key]) => key === field)?.[1];
          return [
            field,
            field === "url" ? `https://example.test/${canary}` : canaryValue(baseValue, canary),
          ];
        }),
      );
      const event = Event.parse({ ...sample, ...injected });

      expect(JSON.stringify(toSafeEvent(event, "sanitizer.v1"))).not.toContain(canary);
    }
  });

  it("projects only decision metadata from tool intents", () => {
    const toolIntentMapping = mappedEvents.find(
      ({ event: candidate }) => candidate.type === "tool_intent",
    );
    if (toolIntentMapping === undefined) {
      throw new Error("The tool intent mapping is missing");
    }
    const toolIntent = toolIntentMapping.event;
    const projected = toSafeEvent(toolIntent, "sanitizer.v1");

    expect(projected).toEqual({
      runId: envelope.runId,
      seq: toolIntent.seq,
      ts: toolIntent.ts,
      traceId: envelope.traceId,
      spanId: envelope.spanId,
      policyVersion: "sanitizer.v1",
      kind: "policy_decision",
      toolId: "tool.test",
      policyDecision: "allow",
      ruleId: "policy.rule",
    });
    expect(JSON.stringify(projected)).not.toContain("POLICY_DESCRIPTION_CANARY");
    expect(projected).not.toHaveProperty("policyReason");
  });

  it("rejects negative repair-attempt counts in parsed SafeEvents", () => {
    const modelResponse = mappedEvents.find(({ event }) => event.type === "model_response");
    if (modelResponse === undefined) {
      throw new Error("The model response mapping is missing");
    }
    expect(
      SafeEvent.safeParse({
        ...toSafeEvent(modelResponse.event, "sanitizer.v1"),
        repairAttempts: -1,
      }).success,
    ).toBe(false);
  });

  it("requires outcome and latency for tool-call SafeEvents", () => {
    const result = mappedEvents.find(({ event }) => event.type === "tool_result");
    if (result === undefined) {
      throw new Error("The tool result mapping is missing");
    }
    const projected = toSafeEvent(result.event, "sanitizer.v1");
    if (projected === null) {
      throw new Error("The tool result was not projected");
    }

    expect(
      SafeEvent.safeParse({
        ...projected,
        outcome: undefined,
      }).success,
    ).toBe(false);
    expect(
      SafeEvent.safeParse({
        ...projected,
        latencyMs: undefined,
      }).success,
    ).toBe(false);
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
