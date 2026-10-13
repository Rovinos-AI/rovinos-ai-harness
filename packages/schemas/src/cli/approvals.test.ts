// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ApprovalShowResultSchema } from "./approvals.js";

describe("ApprovalShowResultSchema", () => {
  it("accepts valid JSON Pointer editable fields and rejects malformed pointers", () => {
    const result = {
      approvalId: "00000000000000000000000001",
      runId: "00000000000000000000000002",
      toolId: "send_mail",
      ruleId: "mail_rule",
      requestedAt: 0,
      ageMs: 0,
      expiresAt: null,
      callId: "00000000000000000000000003",
      reason: "needs_human",
      editableFields: ["/to", "/address~1email"],
    };

    expect(ApprovalShowResultSchema.safeParse(result).success).toBe(true);
    expect(
      ApprovalShowResultSchema.safeParse({ ...result, editableFields: ["/invalid~2escape"] })
        .success,
    ).toBe(false);
  });
});
