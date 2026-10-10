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
    expect(
      Event.safeParse({ ...eventSamples[2], messages: [{ role: "user", parts: [{}] }] }).success,
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
});
