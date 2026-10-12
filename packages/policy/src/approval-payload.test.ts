// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@harness/schemas";
import {
  ApprovalEditError,
  ApprovalPayloadSchema,
  buildApprovalPayload,
  type ApprovalEditTokenizer,
  validateEdits,
} from "./index.js";

const call = {
  callId: "00000000000000000000000000",
  toolId: "mail.send",
  args: { to: "<EMAIL_1>", subject: "Original", metadata: { tag: "keep" } },
};

const rule = {
  ruleId: "confirm_mail",
  reason: "external_email",
  editableFields: ["/subject", "/metadata"],
  approvalTtlMs: 30_000,
};

const inputSchema = {
  type: "object",
  properties: {
    to: { type: "string" },
    subject: { type: "string", maxLength: 40 },
    metadata: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["to", "subject", "metadata"],
  additionalProperties: false,
};

function createPayload() {
  return buildApprovalPayload({ call, rule, now: 100 });
}

const identityTokenizer: ApprovalEditTokenizer = (args) => Promise.resolve(args);

describe("approval payload", () => {
  it("builds a deterministic payload with policy editability, expiry, and fallback text", () => {
    const payload = createPayload();

    expect(payload).toEqual({
      payloadVersion: 1,
      kind: "tool_call",
      ...call,
      ruleId: "confirm_mail",
      reason: "external_email",
      summary: "Tool mail.send requests approval (rule confirm_mail)",
      ui: {
        resourceUri: "ui://harness/approval/v1",
        fallbackText: "Tool mail.send requests approval (rule confirm_mail)",
      },
      editableFields: ["/subject", "/metadata"],
      expiresAt: 30_100,
    });
    expect(buildApprovalPayload({ call, rule, now: 100 })).toEqual(payload);
  });

  it("round-trips through the strict payload schema", () => {
    const payload = createPayload();
    expect(ApprovalPayloadSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(ApprovalPayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
    expect(ApprovalPayloadSchema.safeParse({ ...payload, summary: "x".repeat(501) }).success).toBe(
      false,
    );
  });

  it("builds resume-ambiguity payloads without editable fields or expiry", () => {
    const payload = buildApprovalPayload({
      kind: "resume_ambiguity",
      call,
      rule,
    });

    expect(payload).toMatchObject({
      kind: "resume_ambiguity",
      editableFields: [],
    });
    expect(payload.expiresAt).toBeUndefined();
  });

  it("requires an injected time when a tool-call rule expires", () => {
    expect(() => buildApprovalPayload({ call, rule })).toThrow();
  });
});

describe("validateEdits", () => {
  it("applies nested edits to a copy, validates them, and tokenizes at tool_input", async () => {
    const payload = createPayload();
    let tokenizerContext: Parameters<ApprovalEditTokenizer>[1] | undefined;
    const tokenize: ApprovalEditTokenizer = (args, context) => {
      tokenizerContext = context;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return Promise.resolve(args);
      }
      return Promise.resolve({ ...args, subject: "<EMAIL_2>" });
    };
    const edited = await validateEdits(
      payload,
      [{ pointer: "/subject", value: "person@example.test" }],
      inputSchema,
      tokenize,
    );

    expect(edited).toMatchObject({ subject: "<EMAIL_2>" });
    expect(tokenizerContext).toEqual({
      boundary: "tool_input",
      destination: { tool: "mail.send" },
    });
    expect(payload.args).toEqual(call.args);
  });

  it("allows a child pointer under an editable field", async () => {
    const payload = buildApprovalPayload({
      call: { ...call, args: { ...call.args, metadata: { tag: "keep" } } },
      rule: { ...rule, editableFields: ["/metadata"] },
      now: 100,
    });
    await expect(
      validateEdits(
        payload,
        [{ pointer: "/metadata/tag", value: "changed" }],
        inputSchema,
        identityTokenizer,
      ),
    ).resolves.toMatchObject({ metadata: { tag: "changed" } });
  });

  it("rejects edits outside policy-marked pointers, including textual prefix collisions", async () => {
    const payload = buildApprovalPayload({
      call: { ...call, args: { ...call.args, subjectLine: "unchanged" } },
      rule: { ...rule, editableFields: ["/subject"] },
      now: 100,
    });

    await expect(
      validateEdits(
        payload,
        [{ pointer: "/subjectLine", value: "changed" }],
        inputSchema,
        identityTokenizer,
      ),
    ).rejects.toMatchObject({ code: "edit_not_allowed" });
  });

  it("rejects arguments that do not match the tool input JSON Schema", async () => {
    await expect(
      validateEdits(
        createPayload(),
        [{ pointer: "/subject", value: "x".repeat(41) }],
        inputSchema,
        identityTokenizer,
      ),
    ).rejects.toMatchObject({ code: "edit_invalid" });
  });

  it("rejects malformed schemas and edits whose parent path does not exist", async () => {
    await expect(
      validateEdits(
        createPayload(),
        [{ pointer: "/metadata/missing/value", value: "x" }],
        inputSchema,
        identityTokenizer,
      ),
    ).rejects.toMatchObject({ code: "edit_invalid" });
    await expect(
      validateEdits(
        createPayload(),
        [{ pointer: "/subject", value: "valid" }],
        { type: 5 },
        identityTokenizer,
      ),
    ).rejects.toMatchObject({ code: "edit_invalid" });
  });

  it("safely edits escaped object keys and array items", async () => {
    const payload = buildApprovalPayload({
      call: { ...call, args: { ...call.args, "safe/key": "before", items: ["first"] } },
      rule: { ...rule, editableFields: ["/safe~1key", "/items"] },
      now: 100,
    });
    const schema = {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        metadata: { type: "object" },
        "safe/key": { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
    };

    await expect(
      validateEdits(
        payload,
        [
          { pointer: "/safe~1key", value: "after" },
          { pointer: "/items/0", value: "second" },
        ],
        schema,
        identityTokenizer,
      ),
    ).resolves.toMatchObject({ "safe/key": "after", items: ["second"] });
  });

  it("does not mutate the original arguments when replacing the root", async () => {
    const payload = buildApprovalPayload({
      call: { ...call, args: { nested: { value: "before" } } },
      rule: { ...rule, editableFields: [""] },
      now: 100,
    });
    const replacement: JsonValue = { replaced: true };

    await expect(
      validateEdits(payload, [{ pointer: "", value: replacement }], true, identityTokenizer),
    ).resolves.toEqual(replacement);
    expect(payload.args).toEqual({ nested: { value: "before" } });
  });

  it("returns a typed error for edits on resume-ambiguity requests", async () => {
    const payload = buildApprovalPayload({
      kind: "resume_ambiguity",
      call,
      rule,
    });

    await expect(
      validateEdits(
        payload,
        [{ pointer: "/subject", value: "edited" }],
        inputSchema,
        identityTokenizer,
      ),
    ).rejects.toBeInstanceOf(ApprovalEditError);
  });
});
