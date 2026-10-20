// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Event } from "./events.js";
import { eventSamples } from "./event-samples.test-helpers.js";

describe("Event", () => {
  it.each(eventSamples)("parses $type events and rejects extra keys", (sample) => {
    expect(Event.parse(sample)).toEqual(sample);
    expect(Event.safeParse({ ...sample, unexpected: true }).success).toBe(false);
  });

  it("rejects malformed envelope values, unknown types, and non-JSON content", () => {
    expect(Event.safeParse({ ...eventSamples[0], seq: -1 }).success).toBe(false);
    expect(Event.safeParse({ ...eventSamples[0], type: "unknown" }).success).toBe(false);
    const requestSample = eventSamples.find(({ type }) => type === "model_request");
    expect(
      requestSample?.type === "model_request" &&
        Event.safeParse({
          ...requestSample,
          messages: [{ role: "user", parts: [{}] }],
        }).success,
    ).toBe(false);
    const responseSample = eventSamples.find(({ type }) => type === "model_response");
    expect(
      responseSample?.type === "model_response" &&
        Event.safeParse({ ...responseSample, content: [{ type: "text" }] }).success,
    ).toBe(false);
  });

  it("defaults legacy model responses without fallback depth to zero", () => {
    const modelResponse = eventSamples.find(({ type }) => type === "model_response");
    if (modelResponse?.type !== "model_response") {
      throw new Error("Missing model_response sample.");
    }
    const legacyResponse = { ...modelResponse };
    Reflect.deleteProperty(legacyResponse, "fallbackDepth");
    expect(Event.parse(legacyResponse)).toMatchObject({ fallbackDepth: 0 });
  });

  it("records cached token usage as optional model response metadata", () => {
    const response = eventSamples.find(({ type }) => type === "model_response");
    if (response?.type !== "model_response") {
      throw new Error("Missing model_response sample.");
    }

    expect(Event.parse({ ...response, cacheReadTokens: 4, cacheWriteTokens: 2 })).toMatchObject({
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    });
    expect(Event.safeParse({ ...response, cacheReadTokens: -1 }).success).toBe(false);
  });

  it("requires an approver for human resolutions but not expiry decisions", () => {
    const resolution = eventSamples.find(({ type }) => type === "approval_resolved");
    if (resolution?.type !== "approval_resolved") {
      throw new Error("Missing approval_resolved sample.");
    }
    const withoutDecidedBy = { ...resolution };
    Reflect.deleteProperty(withoutDecidedBy, "decidedBy");

    expect(Event.parse(withoutDecidedBy)).toMatchObject({ decidedBy: "human" });
    const withoutApprover = { ...resolution };
    Reflect.deleteProperty(withoutApprover, "approverId");
    expect(Event.safeParse(withoutApprover).success).toBe(false);
    expect(
      Event.parse({ ...withoutApprover, decidedBy: "expiry", reason: "expired" }),
    ).toMatchObject({ decidedBy: "expiry", reason: "expired" });
    expect(Event.parse({ ...resolution, decidedBy: "expiry", reason: "expired" })).toMatchObject({
      decidedBy: "expiry",
      reason: "expired",
    });
  });

  it("requires an approver for human input resolutions and omits answers on declines", () => {
    const resolution = eventSamples.find(({ type }) => type === "input_resolved");
    if (resolution?.type !== "input_resolved") {
      throw new Error("Missing input_resolved sample.");
    }

    const withoutApprover = { ...resolution };
    Reflect.deleteProperty(withoutApprover, "approverId");
    expect(Event.safeParse(withoutApprover).success).toBe(false);
    expect(
      Event.safeParse({ ...withoutApprover, decidedBy: "expiry" }).success,
    ).toBe(true);
    expect(
      Event.safeParse({ ...resolution, action: "decline", answer: { private: "value" } }).success,
    ).toBe(false);
  });

  it("accepts continuation links and follow-up inputs as metadata", () => {
    const created = eventSamples.find(({ type }) => type === "run_created");
    const input = eventSamples.find(({ type }) => type === "run_input");
    if (created?.type !== "run_created" || input?.type !== "run_input") {
      throw new Error("Missing run event samples.");
    }

    expect(Event.parse({ ...created, continuationOf: created.runId })).toMatchObject({
      continuationOf: created.runId,
    });
    expect(Event.parse({ ...input, inputKind: "follow_up" })).toMatchObject({
      inputKind: "follow_up",
    });
    expect(Event.safeParse({ ...input, inputKind: "other" }).success).toBe(false);
  });

  it("requires nonnegative token usage on terminal subagent events", () => {
    const completed = eventSamples.find(({ type }) => type === "subagent_completed");
    if (completed?.type !== "subagent_completed") {
      throw new Error("Missing subagent completion sample.");
    }

    expect(
      Event.parse({ ...completed, inputTokens: 10, outputTokens: 4, costMicros: 3 }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 4, costMicros: 3 });
    expect(Event.safeParse({ ...completed, inputTokens: -1 }).success).toBe(false);
    expect(Event.safeParse({ ...completed, outputTokens: -1 }).success).toBe(false);
    expect(Event.safeParse({ ...completed, costMicros: -1 }).success).toBe(false);
    const withoutInput = { ...completed };
    Reflect.deleteProperty(withoutInput, "inputTokens");
    expect(Event.safeParse(withoutInput).success).toBe(false);
  });
});
