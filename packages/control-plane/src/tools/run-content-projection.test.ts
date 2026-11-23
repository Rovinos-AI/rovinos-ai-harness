// SPDX-License-Identifier: Apache-2.0
import { foldRunState } from "@rovinos/core";
import { eventSamples, Id } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRunContent } from "./run-content.js";
import { readRunState } from "./run-state.js";

vi.mock("./run-state.js", () => ({ readRunState: vi.fn() }));

const runId = Id.parse("C".repeat(26));
const store = new InMemoryEventStore();

function getRunCreatedEvent(): Extract<Event, { readonly type: "run_created" }> {
  const event = eventSamples.find(({ type }) => type === "run_created");
  if (event?.type !== "run_created") {
    throw new Error("Missing run-created event fixture.");
  }
  return event;
}

const runCreated = getRunCreatedEvent();

function fixtureEvents(): Event[] {
  return eventSamples.map((event, seq) => ({
    ...event,
    runId,
    segmentId: runId,
    seq,
    ts: seq + 1,
  }));
}

function setRun(events: Event[] | undefined): void {
  vi.mocked(readRunState).mockResolvedValue(
    events === undefined
      ? undefined
      : {
          events,
          state: foldRunState([runCreated]),
          policyVersion: runCreated.policyVersion,
        },
  );
}

describe("run content projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects each tokenized content event and omits metadata-only events", async () => {
    const events = fixtureEvents();
    setRun(events);

    const result = await getRunContent(store, { runId });

    expect(result?.events.map(({ type }) => type)).toEqual([
      "run_input",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "approval_requested",
      "input_requested",
      "input_resolved",
    ]);
  });

  it("honors sinceSeq and returns undefined for an unknown run", async () => {
    setRun(fixtureEvents());

    const result = await getRunContent(store, { runId, sinceSeq: 4 });

    expect(result?.events.every(({ seq }) => seq > 4)).toBe(true);
    setRun(undefined);
    await expect(getRunContent(store, { runId })).resolves.toBeUndefined();
  });

  it("limits the response to the most recent content events", async () => {
    const request = eventSamples.find((event) => event.type === "model_request");
    if (request?.type !== "model_request") {
      throw new Error("Missing model-request event fixture.");
    }
    const events: Event[] = Array.from({ length: 102 }, (_, seq) => ({
      ...request,
      runId,
      segmentId: runId,
      seq,
      ts: seq + 1,
    }));
    setRun(events);

    const result = await getRunContent(store, { runId });

    expect(result?.truncated).toBe(true);
    expect(result?.events).toHaveLength(100);
    expect(result?.events[0]?.seq).toBe(2);
  });
});
