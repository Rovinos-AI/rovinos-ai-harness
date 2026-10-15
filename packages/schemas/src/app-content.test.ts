// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppContentEnvelopeSchema } from "./app-content.js";

describe("AppContentEnvelopeSchema", () => {
  it("validates labeled app content with its run and app identity", () => {
    expect(
      AppContentEnvelopeSchema.parse({
        kind: "message",
        source: "app",
        label: "App-provided",
        appId: "approval.app",
        runId: "00000000000000000000000001",
        content: { text: "<EMAIL_1>" },
      }),
    ).toMatchObject({ source: "app", label: "App-provided", appId: "approval.app" });
  });

  it("rejects unexpected fields and malformed identifiers", () => {
    const input = {
      kind: "message",
      source: "app",
      label: "App-provided",
      appId: "approval.app",
      runId: "00000000000000000000000001",
      content: null,
    };
    expect(AppContentEnvelopeSchema.safeParse({ ...input, trust: "trusted" }).success).toBe(false);
    expect(AppContentEnvelopeSchema.safeParse({ ...input, appId: "not a code" }).success).toBe(
      false,
    );
  });
});
