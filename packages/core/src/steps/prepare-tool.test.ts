// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { EventSchema, FakeClock, HarnessError, type Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import type { ModelCompletion, ToolPort } from "../ports.js";
import { RunRecorder } from "../recorder.js";
import {
  prepareCompletion,
  prepareToolCall,
  SummaryRecordingError,
  toolRunContext,
} from "./prepare-tool.js";
import { toolErrorCode } from "./tool-execution.js";

const id = "00000000000000000000000001";
const call = { callId: id, toolId: "synthetic.tool", args: "synthetic@example.test" };
const context = { runId: id, signal: new AbortController().signal };
const summary = {
  boundary: "tool_input" as const,
  action: "tokenize" as const,
  entities: [{ type: "email", count: 1 }],
};

class BlockedError extends HarnessError {
  readonly code = "pii_blocked";
  constructor() {
    super("Sensitive content blocked");
  }
}

function tool(): ToolPort {
  return {
    describe: () => ({ idempotent: true, timeoutMs: 100 }),
    execute: () => Promise.resolve({ outcome: "ok", result: null }),
  };
}

function completion(): ModelCompletion {
  return {
    provider: "test",
    model: "test",
    parts: [
      { type: "tool_call", ...call },
      { type: "text", text: "done" },
    ],
    providerBlobs: { duplicated: call.args },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "tool_calls",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

describe("tool preparation", () => {
  it("prepares once and retains sanitized arguments in the response and execution list", async () => {
    const port = tool();
    const prepare = vi.fn(() => Promise.resolve({ ...call, args: "<EMAIL_1>" }));
    port.prepare = prepare;
    const prepared = await prepareCompletion(completion(), port, context);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepared.preparedCalls).toEqual([{ call: { ...call, args: "<EMAIL_1>" } }]);
    expect(prepared.completion.parts[0]).toMatchObject({ args: "<EMAIL_1>" });
    expect(prepared.completion.providerBlobs).toBeNull();
    expect(JSON.stringify(prepared)).not.toContain(call.args);
  });

  it("retains failed calls as non-executable durable recovery input", async () => {
    const port = tool();
    port.prepare = () => Promise.reject(new BlockedError());
    const prepared = await prepareCompletion(completion(), port, context);
    expect(prepared.completion.parts).toEqual([
      { type: "tool_call", ...call, args: null },
      { type: "text", text: "done" },
    ]);
    expect(prepared.preparedCalls).toEqual([
      { call: { ...call, args: null }, errorCode: "pii_blocked" },
    ]);
    expect(JSON.stringify(prepared)).not.toContain(call.args);
  });

  it("uses a fixed fallback instead of arbitrary attacker exception codes", async () => {
    const port = tool();
    port.prepare = () => Promise.reject(Object.assign(new Error(call.args), { code: call.args }));
    await expect(prepareToolCall(port, call, context)).resolves.toEqual({
      call: { ...call, args: null },
      errorCode: "pii_prepare_failed",
    });
  });

  it("keeps ports without preparation backward compatible", async () => {
    await expect(prepareToolCall(tool(), call, context)).resolves.toEqual({ call });
    const prepared = await prepareCompletion(completion(), undefined, context);
    expect(prepared.completion).toEqual(completion());
  });

  it("records metadata-only summaries through RunRecorder and retains persistence failures", async () => {
    const recorder = new RunRecorder(new InMemoryEventStore(), id, id, 0, new FakeClock(1));
    const event = EventSchema.parse({
      type: "pii_action",
      v: 1,
      runId: id,
      segmentId: id,
      seq: 0,
      ts: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      boundary: "tool_input",
      action: "tokenized",
      entities: summary.entities,
    });
    const record = vi.spyOn(recorder, "record").mockResolvedValue(event);
    const events: Event[] = [];
    const recordingContext = toolRunContext(context, recorder, events);
    await recordingContext.recordPiiAction?.(summary);
    expect(events).toEqual([event]);
    expect(record).toHaveBeenCalledWith({
      type: "pii_action",
      v: 1,
      boundary: "tool_input",
      action: "tokenized",
      entities: summary.entities,
    });
    const failure = new Error("append failed");
    record.mockRejectedValue(failure);
    const port = tool();
    port.prepare = async (proposed, ctx) => {
      await ctx.recordPiiAction?.(summary);
      return proposed;
    };
    await expect(prepareToolCall(port, call, recordingContext)).rejects.toBe(failure);
    expect(() => toolErrorCode(new SummaryRecordingError(failure))).toThrow(failure);
  });
});
