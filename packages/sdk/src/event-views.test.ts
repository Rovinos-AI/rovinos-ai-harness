// SPDX-License-Identifier: Apache-2.0
import { EVENT_FIELD_CLASS, eventSamples } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { contentEntries } from "./event-views.js";
import { RunContentEntrySchema, RunContentSchema } from "./types.js";

describe("content event projections", () => {
  it("validates every content-bearing event type and excludes metadata-only types", () => {
    const approvalResolution = eventSamples.find(({ type }) => type === "approval_resolved");
    if (approvalResolution?.type !== "approval_resolved") {
      throw new Error("Missing approval_resolved sample.");
    }

    const events = [...eventSamples, { ...approvalResolution, edits: { approved: true } }];
    const entries = RunContentSchema.parse(contentEntries(events));
    const expectedTypes = Object.entries(EVENT_FIELD_CLASS)
      .filter(([, fields]) => Object.values(fields).includes("content"))
      .map(([type]) => type);
    const metadataOnlyTypes = Object.entries(EVENT_FIELD_CLASS)
      .filter(([, fields]) => !Object.values(fields).includes("content"))
      .map(([type]) => type);
    const projectedTypes = new Set(entries.map(({ type }) => type));
    const schemaTypes = new Set(RunContentEntrySchema.shape.type.options);

    expect(projectedTypes).toEqual(new Set(expectedTypes));
    expect(schemaTypes).toEqual(new Set(expectedTypes));
    expect(projectedTypes).toContain("input_requested");
    expect(projectedTypes).toContain("input_resolved");
    expect(projectedTypes).toContain("app_content");
    expect(entries.some(({ type }) => metadataOnlyTypes.includes(type))).toBe(false);
  });
});
