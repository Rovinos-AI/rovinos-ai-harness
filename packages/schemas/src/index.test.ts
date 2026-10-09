// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import {
  EVENT_FIELD_CLASS,
  Event,
  HARNESS_VERSION,
  joinEvent,
  RunStatus,
  splitEvent,
} from "./index.js";
import type { NewEvent } from "./index.js";
import { eventSamples } from "./event-samples.js";

test("exports the harness version", () => {
  expect(HARNESS_VERSION).toBe("0.0.0");
});

test("exports the event schema, classification, and split/join API", () => {
  const sample = eventSamples.find(({ type }) => type === "run_created");
  if (sample?.type !== "run_created") {
    throw new Error("Missing run_created sample.");
  }
  const parts = splitEvent(Event.parse(sample));
  const { seq, ...newEvent } = sample;
  const typedNewEvent: NewEvent = newEvent;

  expect(EVENT_FIELD_CLASS.run_created.configHash).toBe("meta");
  expect(RunStatus.parse("running")).toBe("running");
  expect(joinEvent(parts.meta, parts.content)).toEqual(sample);
  expect(seq).toBe(0);
  expect(typedNewEvent).toMatchObject({ type: "run_created" });
});
