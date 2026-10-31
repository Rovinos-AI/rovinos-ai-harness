// SPDX-License-Identifier: Apache-2.0
import {
  FakeClock,
  EventSchema,
  Id,
  JsonValue,
  ModelRequestSchema,
  SequentialIdGenerator,
} from "@rovinos/schemas";
import { AdapterRegistry, ModelGateway } from "@rovinos/models";
import type { ProviderAdapter } from "@rovinos/models";
import { describe, expect, it, vi } from "vitest";
import type { ModelCompletion, ModelToolCall, RunContext } from "../ports.js";
import { RunEventRecordingError } from "../recorder.js";
import { foldRunState } from "../run-state.js";
import { planDanglingIntents } from "../resume-policy.js";
import { VerifyTool } from "./verify-tool.js";

const callId = Id.parse("11111111111111111111111111");
const input = JsonValue.parse({
  criteria: [{ id: "accurate", description: "Is the answer accurate?" }],
  subject: { answer: "42" },
});
const verdict = JsonValue.parse({
  criteria: [{ id: "accurate", met: true }],
  verdict: "pass",
});

function completion(value: ReturnType<typeof JsonValue.parse>): ModelCompletion {
  return {
    parts: [{ type: "text", text: JSON.stringify(value) }],
    usage: { inputTokens: 4, outputTokens: 2, costMicros: 3 },
    finishReason: "stop",
    provider: "test",
    model: "judge",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
    enforcement: { value, valid: true, rungUsed: "native" },
  };
}

function call(args: ReturnType<typeof JsonValue.parse> = input): ModelToolCall {
  return { callId, toolId: "agent.verify", args };
}

describe("VerifyTool", () => {
  it("makes one temperature-zero structured judge request and returns its validated verdict", async () => {
    const requestStructuredModel = vi.fn(
      (_request: Parameters<NonNullable<RunContext["requestStructuredModel"]>>[0]) =>
        Promise.resolve(completion(verdict)),
    );
    const context: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel,
    };

    const result = await new VerifyTool().execute(call(), context);

    expect(result).toEqual({ outcome: "ok", result: verdict });
    expect(requestStructuredModel).toHaveBeenCalledOnce();
    expect(requestStructuredModel.mock.calls[0]?.[0]).toMatchObject({
      temperature: 0,
      outputSchema: expect.objectContaining({ _zod: expect.any(Object) }),
    });
    expect(requestStructuredModel.mock.calls[0]?.[0].signal).toBe(context.signal);
  });

  it("rejects malformed or duplicate criteria before requesting a judge", async () => {
    const requestStructuredModel = vi.fn(() => Promise.resolve(completion(verdict)));
    const context: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel,
    };

    const tooMany = await new VerifyTool().execute(
      call(JsonValue.parse({ criteria: [], subject: null })),
      context,
    );
    const duplicate = await new VerifyTool().execute(
      call(
        JsonValue.parse({
          criteria: [
            { id: "accurate", description: "First." },
            { id: "accurate", description: "Second." },
          ],
          subject: null,
        }),
      ),
      context,
    );

    expect(tooMany).toMatchObject({ outcome: "error", errorCode: "verify_failed" });
    expect(duplicate).toMatchObject({ outcome: "error", errorCode: "verify_failed" });
    expect(requestStructuredModel).not.toHaveBeenCalled();
  });

  it("returns a stable error when model output is invalid or the request fails", async () => {
    const invalid = JsonValue.parse({
      criteria: [{ id: "other", met: true }],
      verdict: "pass",
    });
    const invalidContext: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel: () => Promise.resolve(completion(invalid)),
    };
    const failedContext: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel: () => Promise.reject(new Error("provider details")),
    };
    const recordingError = new RunEventRecordingError(new Error("store failure"));
    const recordingFailureContext: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel: () => Promise.reject(recordingError),
    };

    await expect(new VerifyTool().execute(call(), invalidContext)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "verify_failed",
    });
    await expect(new VerifyTool().execute(call(), failedContext)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "verify_failed",
    });
    await expect(new VerifyTool().execute(call(), recordingFailureContext)).rejects.toBe(
      recordingError,
    );
  });

  it("returns verify_failed when the gateway exhausts structured-output repairs", async () => {
    const adapter: ProviderAdapter = {
      provider: "test",
      kind: "openai",
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: '{"criteria":[],"verdict":"pass"}' }],
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: "stop",
          latencyMs: 1,
        }),
    };
    const ids = new SequentialIdGenerator();
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids,
      clock: new FakeClock(1),
      enforcement: { maxRepairs: 0 },
    });
    const context: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel: ({ messages, outputSchema, temperature }) =>
        gateway.complete(
          ModelRequestSchema.parse({
            requestId: ids.next(),
            model: { provider: "test", model: "fixture" },
            role: "judge",
            messages,
            temperature,
          }),
          { runId: callId, signal: new AbortController().signal, outputSchema },
        ),
    };

    await expect(new VerifyTool().execute(call(), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "verify_failed",
    });
  });

  it.each([
    [
      "missing",
      { criteria: [{ id: "accurate", met: true }], verdict: "fail" },
    ],
    [
      "extra",
      {
        criteria: [
          { id: "accurate", met: true },
          { id: "unexpected", met: false },
        ],
        verdict: "pass",
      },
    ],
  ])("repairs %s criterion ids through the gateway", async (_label, invalid) => {
    const requests: ModelCompletion["parts"][] = [];
    const expected = JsonValue.parse({
      criteria: [
        { id: "accurate", met: true },
        { id: "complete", met: true },
      ],
      verdict: "pass",
    });
    const outputs = [
      JSON.stringify(invalid),
      JSON.stringify(expected),
    ];
    const adapter: ProviderAdapter = {
      provider: "test",
      kind: "openai",
      complete: (request) => {
        requests.push(request.messages.flatMap(({ parts }) => parts));
        return Promise.resolve({
          parts: [{ type: "text", text: outputs.shift() ?? "" }],
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: "stop",
          latencyMs: 1,
        });
      },
    };
    const ids = new SequentialIdGenerator();
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids,
      clock: new FakeClock(1),
      enforcement: { maxRepairs: 1 },
    });
    const args = JsonValue.parse({
      criteria: [
        { id: "accurate", description: "Is the response accurate?" },
        { id: "complete", description: "Is the response complete?" },
      ],
      subject: "An answer.",
    });
    const context: RunContext = {
      runId: callId,
      signal: new AbortController().signal,
      requestStructuredModel: ({ messages, outputSchema, temperature }) =>
        gateway.complete(
          ModelRequestSchema.parse({
            requestId: ids.next(),
            model: { provider: "test", model: "fixture" },
            role: "judge",
            messages,
            temperature,
          }),
          { runId: callId, signal: new AbortController().signal, outputSchema },
        ),
    };

    const result = await new VerifyTool().execute(call(args), context);

    expect(result).toEqual({ outcome: "ok", result: expected });
    expect(requests).toHaveLength(2);
  });

  it("is idempotent and only describes its own tool id", () => {
    const tool = new VerifyTool();

    expect(tool.describe("agent.verify")).toEqual({ idempotent: true, timeoutMs: 60_000 });
    expect(tool.describe("other.tool")).toBeUndefined();
  });

  it("allows a dangling verifier intent to rerun after resume", () => {
    const state = foldRunState([
      EventSchema.parse({
        runId: callId,
        seq: 0,
        ts: 0,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: callId,
        type: "run_created",
        configHash: "c".repeat(64),
        policyVersion: "test.policy",
      }),
      EventSchema.parse({
        runId: callId,
        seq: 1,
        ts: 1,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: callId,
        type: "tool_intent",
        callId,
        toolId: "agent.verify",
        idempotent: true,
        policyDecision: "allow",
        argsHash: "d".repeat(64),
        args: input,
      }),
    ]);

    expect(planDanglingIntents(state, new VerifyTool())).toEqual([{ kind: "rerun", callId }]);
  });
});
