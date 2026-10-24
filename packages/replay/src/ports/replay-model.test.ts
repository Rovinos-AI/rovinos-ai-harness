// SPDX-License-Identifier: Apache-2.0
import {
  Event as EventSchema,
  Id,
  ModelRequestSchema,
  type Event,
  type ModelRequest,
} from "@harness/schemas";
import { requestHash } from "@harness/models";
import { ResolvedRunSchema } from "../resolve.js";
import { describe, expect, it } from "vitest";
import { ReplayDivergenceError, ReplayModelPort } from "./replay-model.js";
import type { ReplayMissingResultError } from "./replay-model.js";

const runId = Id.parse("00000000000000000000000001");
const childRunId = Id.parse("00000000000000000000000007");
const segmentId = Id.parse("00000000000000000000000002");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const ids = { next: () => Id.parse("00000000000000000000000009") };
const clock = { now: () => 100 };

function base(seq: number, eventRunId = runId) {
  return { runId: eventRunId, seq, ts: seq + 1, v: 1, traceId, spanId, segmentId };
}

function request(text: string, requestId: string): ModelRequest {
  return ModelRequestSchema.parse({
    requestId,
    model: { provider: "recorded", model: "model" },
    role: "assistant",
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
    maxOutputTokens: 4096,
  });
}

function requestEvent(seq: number, req: ModelRequest, eventRunId = runId): Event {
  return EventSchema.parse({
    ...base(seq, eventRunId),
    type: "model_request",
    requestId: req.requestId,
    provider: req.model.provider,
    model: req.model.model,
    role: req.role,
    requestHash: requestHash(req),
    messages: req.messages,
  });
}

function responseEvent(seq: number, req: ModelRequest, text: string, eventRunId = runId): Event {
  return EventSchema.parse({
    ...base(seq, eventRunId),
    type: "model_response",
    requestId: req.requestId,
    provider: req.model.provider,
    model: req.model.model,
    inputTokens: 2,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 5,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text }],
    providerBlobs: null,
  });
}

function resolved(events: readonly Event[]) {
  return ResolvedRunSchema.parse({
    rootRunId: runId,
    runs: [{ runId, role: "root", events }],
  });
}

const runCreated = EventSchema.parse({
  ...base(0),
  type: "run_created",
  configHash: "c".repeat(64),
  policyVersion: "test",
});

describe("ReplayModelPort", () => {
  it("serves recorded responses in order through the cassette provider", async () => {
    const first = request("first prompt", "00000000000000000000000003");
    const second = request("second prompt", "00000000000000000000000004");
    const model = new ReplayModelPort(
      resolved([
        runCreated,
        requestEvent(1, first),
        responseEvent(2, first, "first response"),
        requestEvent(3, second),
        responseEvent(4, second, "second response"),
      ]),
      { ids, clock },
    );

    const firstResult = await model.complete(
      { ...first, model: { ...first.model, provider: "cassette" } },
      { runId, signal: new AbortController().signal },
    );
    const secondResult = await model.complete(
      { ...second, model: { ...second.model, provider: "cassette" } },
      { runId, signal: new AbortController().signal },
    );

    expect(firstResult.parts).toEqual([{ type: "text", text: "first response" }]);
    expect(secondResult.parts).toEqual([{ type: "text", text: "second response" }]);
  });

  it("reports only a sequence and closed hash-mismatch code on divergence", async () => {
    const recorded = request("recorded prompt", "00000000000000000000000003");
    const model = new ReplayModelPort(
      resolved([runCreated, requestEvent(1, recorded), responseEvent(2, recorded, "recorded")]),
      { ids, clock },
    );
    const changed = request("changed prompt", "00000000000000000000000003");

    const error = await model
      .complete(
        { ...changed, model: { ...changed.model, provider: "cassette" } },
        { runId, signal: new AbortController().signal },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplayDivergenceError);
    if (!(error instanceof ReplayDivergenceError)) {
      throw error;
    }
    expect(error).toMatchObject({
      code: "replay_divergence",
      seq: 1,
      hashMismatchCode: "model_request_hash_mismatch",
    });
    expect("expectedHash" in error).toBe(false);
    expect("actualHash" in error).toBe(false);
  });

  it("reports a missing result for an interrupted final request", async () => {
    const interrupted = request("interrupted prompt", "00000000000000000000000003");
    const model = new ReplayModelPort(resolved([runCreated, requestEvent(1, interrupted)]), {
      ids,
      clock,
    });

    await expect(
      model.complete(
        { ...interrupted, model: { ...interrupted.model, provider: "cassette" } },
        { runId, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "replay_missing_result",
      seq: 1,
    } satisfies Partial<ReplayMissingResultError>);
  });

  it("serves a subagent response from that run's event log", async () => {
    const childRequest = request("child prompt", "00000000000000000000000008");
    const childCreated = EventSchema.parse({
      ...base(0, childRunId),
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
      parentRunId: runId,
    });
    const resolvedWithChild = ResolvedRunSchema.parse({
      rootRunId: runId,
      runs: [
        { runId, role: "root", events: [runCreated] },
        {
          runId: childRunId,
          role: "subagent",
          parentRunId: runId,
          events: [
            childCreated,
            requestEvent(1, childRequest, childRunId),
            responseEvent(2, childRequest, "child response", childRunId),
          ],
        },
      ],
    });
    const model = new ReplayModelPort(resolvedWithChild, { ids, clock });

    const result = await model.complete(childRequest, {
      runId: childRunId,
      signal: new AbortController().signal,
    });

    expect(result.parts).toEqual([{ type: "text", text: "child response" }]);
  });
});
