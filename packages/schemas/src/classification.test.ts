// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from "vitest";
import { EVENT_FIELD_CLASS, joinEvent, splitEvent } from "./classification.js";
import { EventSchema, type EventType, type PayloadKeys } from "./events.js";
import type { EventFieldClass } from "./classification.js";
import { ContractError } from "./parse.js";
import { eventSamples } from "./event-samples.test-helpers.js";

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "v", "traceId", "spanId", "segmentId"]);
type EventClassificationMap = {
  [T in EventType]: Record<PayloadKeys<T>, EventFieldClass>;
};

const missingPayloadClassification = {
  ...EVENT_FIELD_CLASS,
  // @ts-expect-error -- run_created must classify configHash.
  run_created: { policyVersion: "meta", parentRunId: "meta" },
} satisfies EventClassificationMap;

const extraPayloadClassification = {
  ...EVENT_FIELD_CLASS,
  run_created: {
    ...EVENT_FIELD_CLASS.run_created,
    // @ts-expect-error -- run_created cannot classify an undeclared field.
    unclassified: "meta",
  },
} satisfies EventClassificationMap;

function captureContractError(action: () => unknown): ContractError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    if (error instanceof ContractError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a contract error.");
}

describe("EVENT_FIELD_CLASS", () => {
  it("classifies every payload field in every event schema", () => {
    for (const eventSchema of EventSchema.options) {
      const type = eventSchema.shape.type.value;
      const classifications = EVENT_FIELD_CLASS[type];
      const payloadKeys = Object.keys(eventSchema.shape).filter((key) => !envelopeKeys.has(key));

      expect(Object.keys(classifications).sort()).toEqual(payloadKeys.sort());
    }
  });

  it.each(eventSamples)("splits and rejoins $type without content in meta", (event) => {
    const { meta, content } = splitEvent(event);
    const expectedContentKeys = Object.entries(EVENT_FIELD_CLASS[event.type])
      .filter(([, fieldClass]) => fieldClass === "content")
      .map(([key]) => key)
      .filter((key) => Object.hasOwn(event, key));

    expect(Object.keys(content).sort()).toEqual(expectedContentKeys.sort());
    for (const key of expectedContentKeys) {
      expect(meta).not.toHaveProperty(key);
    }
    expect(joinEvent(meta, content)).toEqual(event);
  });

  it("omits undefined optional fields and validates joined records", () => {
    const eventSample = eventSamples.find(({ type }) => type === "run_created");
    if (eventSample?.type !== "run_created") {
      throw new Error("Missing run_created sample.");
    }
    const parts = splitEvent({ ...eventSample, parentRunId: undefined });
    expect(parts.meta).not.toHaveProperty("parentRunId");
    expect(joinEvent(parts.meta, parts.content)).toEqual(eventSample);
    expect(() => joinEvent({ ...parts.meta, seq: -1 }, parts.content)).toThrow();
  });

  it("enforces the field classification when joining stored event parts", () => {
    const runCreated = eventSamples.find(({ type }) => type === "run_created");
    const modelRequest = eventSamples.find(({ type }) => type === "model_request");
    if (runCreated?.type !== "run_created" || modelRequest?.type !== "model_request") {
      throw new Error("Missing event samples.");
    }

    const runCreatedParts = splitEvent(runCreated);
    const { configHash, ...metaWithoutConfigHash } = runCreatedParts.meta;
    const metaFieldInContent = captureContractError(() =>
      joinEvent(metaWithoutConfigHash, { ...runCreatedParts.content, configHash: "private-value" }),
    );
    expect(metaFieldInContent.issues).toContainEqual({
      path: ["content", "configHash"],
      code: "field_classification_mismatch",
    });
    expect(JSON.stringify(metaFieldInContent)).not.toContain("private-value");

    const modelRequestParts = splitEvent(modelRequest);
    const { messages, ...contentWithoutMessages } = modelRequestParts.content;
    const contentFieldInMeta = captureContractError(() =>
      joinEvent({ ...modelRequestParts.meta, messages }, contentWithoutMessages),
    );
    expect(contentFieldInMeta.issues).toContainEqual({
      path: ["meta", "messages"],
      code: "field_classification_mismatch",
    });

    const duplicateField = captureContractError(() =>
      joinEvent(runCreatedParts.meta, { ...runCreatedParts.content, configHash }),
    );
    expect(duplicateField.issues).toContainEqual({
      path: ["configHash"],
      code: "duplicate_field",
    });
  });

  it("keeps the classification map exhaustive at compile time", () => {
    expectTypeOf(EVENT_FIELD_CLASS).toExtend<EventClassificationMap>();
    expect(missingPayloadClassification).toBeDefined();
    expect(extraPayloadClassification).toBeDefined();
  });

  it("maps all declared event types", () => {
    const eventTypes = Object.keys(EVENT_FIELD_CLASS);
    expect(eventTypes).toHaveLength(15);
    expect(eventTypes).toEqual(expect.arrayContaining(eventSamples.map(({ type }) => type)));
  });
});
