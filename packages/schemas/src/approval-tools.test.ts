// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ApprovalAppGetRequestSchema,
  ApprovalAppInputSchema,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
} from "./approval-tools.js";

const approvalId = "00000000000000000000000001";
const payload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000002",
  toolId: "mail.send",
  ruleId: "mail.review",
  reason: "approval_required",
  summary: "Review pending mail",
  args: { to: "<EMAIL_1>" },
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review pending mail" },
  editableFields: ["/to"],
};

describe("approval tool contracts", () => {
  it("validates the pending approval lookup request", () => {
    expect(ApprovalAppGetRequestSchema.parse({ approvalId })).toEqual({ approvalId });
    expect(ApprovalAppGetRequestSchema.safeParse({ approvalId, runId: approvalId }).success).toBe(
      false,
    );
  });

  it("validates app input with a distinct approval id", () => {
    expect(ApprovalAppInputSchema.parse({ approvalId, payload })).toEqual({ approvalId, payload });
    expect(
      ApprovalAppInputSchema.safeParse({ approvalId: payload.callId, ...payload }).success,
    ).toBe(false);
  });

  it("validates strict resolve requests and typed edits", () => {
    expect(
      ResolveRequest.parse({
        approvalId,
        decision: "edit",
        edits: [
          { pointer: "/name", value: "changed" },
          { pointer: "/count", value: 3 },
          { pointer: "/active", value: false },
        ],
      }),
    ).toMatchObject({ approvalId, decision: "edit" });
    expect(ResolveRequest.safeParse({ approvalId, decision: "approve", extra: true }).success).toBe(
      false,
    );
    expect(
      ResolveRequest.safeParse({
        approvalId,
        decision: "edit",
        edits: [{ pointer: "/bad~2escape", value: "x" }],
      }).success,
    ).toBe(false);
  });

  it("validates resolve outcomes with optional closed codes", () => {
    expect(ResolveResponse.parse({ ok: true })).toEqual({ ok: true });
    expect(ResolveResponse.parse({ ok: false, code: "approval_not_found" })).toEqual({
      ok: false,
      code: "approval_not_found",
    });
    expect(ResolveResponse.safeParse({ ok: false, code: "NOT A CODE" }).success).toBe(false);
  });

  it("limits reveal pointers and validates returned values strictly", () => {
    const pointers = Array.from({ length: 20 }, (_, index) => `/field${String(index)}`);
    expect(RevealRequest.parse({ approvalId, pointers })).toEqual({ approvalId, pointers });
    expect(RevealRequest.safeParse({ approvalId, pointers: [...pointers, "/extra"] }).success).toBe(
      false,
    );
    expect(
      RevealResponse.parse({ values: [{ pointer: "/to", value: "person@example.test" }] }),
    ).toEqual({ values: [{ pointer: "/to", value: "person@example.test" }] });
    expect(RevealResponse.safeParse({ values: [{ pointer: "/to", value: 12 }] }).success).toBe(
      false,
    );
    expect(RevealResponse.safeParse({ values: [], extra: true }).success).toBe(false);
  });
});
