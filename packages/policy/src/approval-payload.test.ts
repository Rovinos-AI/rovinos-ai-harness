// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@harness/schemas";
import {
  ApprovalEditError,
  ApprovalPayloadSchema,
  buildApprovalPayload,
  diffToEdits,
  type ApprovalEditTokenizer,
  validateEdits,
} from "./index.js";

const call = {
  callId: "00000000000000000000000000",
  toolId: "mail.send",
  args: { to: "<EMAIL_1>", subject: "Original", metadata: { tag: "keep" } },
};

const rule = {
  id: "confirm_mail",
  reason: "external_email",
  editable: ["/subject", "/metadata"],
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
  it("builds a deterministic payload with policy editable fields, expiry, and fallback text", () => {
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
    expect(
      ApprovalPayloadSchema.safeParse({
        ...payload,
        kind: "resume_ambiguity",
      }).success,
    ).toBe(false);
  });

  it("builds resume-ambiguity payloads without editable fields and retains expiry", () => {
    const payload = buildApprovalPayload({
      kind: "resume_ambiguity",
      call,
      rule,
      now: 100,
    });

    expect(payload).toMatchObject({
      kind: "resume_ambiguity",
      editableFields: [],
      expiresAt: 30_100,
    });
  });

  it("requires an injected time when either approval kind expires", () => {
    expect(() => buildApprovalPayload({ call, rule })).toThrow();
    expect(() => buildApprovalPayload({ kind: "resume_ambiguity", call, rule })).toThrow();
  });

  it("includes a closed error code on the resume-ambiguity refinement issue", () => {
    const result = ApprovalPayloadSchema.safeParse({
      ...createPayload(),
      kind: "resume_ambiguity",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.code).toBe("custom");
      if (issue?.code === "custom") {
        expect(issue.params).toEqual({ errorCode: "approval_payload_resume_editable" });
      }
    }
  });

  it("converts changed whole arguments into pointer edits, including removals and array changes", () => {
    expect(
      diffToEdits(
        { metadata: { keep: true, remove: "old" }, items: ["first", "second"] },
        { metadata: { keep: false }, items: ["changed"] },
      ),
    ).toEqual([
      { pointer: "/metadata/keep", value: false },
      { pointer: "/metadata/remove", remove: true },
      { pointer: "/items/0", value: "changed" },
      { pointer: "/items/1", remove: true },
    ]);
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
      rule: { ...rule, editable: ["/metadata"] },
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
      rule: { ...rule, editable: ["/subject"] },
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

  it("validates tokenized unchanged fields with an injected token-aware schema validator", async () => {
    const payload = buildApprovalPayload({
      call: {
        ...call,
        args: { to: "<EMAIL_1>", cc: "<EMAIL_2>", subject: "Original" },
      },
      rule: { ...rule, editable: ["/subject"] },
      now: 100,
    });
    const schema = {
      type: "object",
      properties: {
        to: { type: "string", format: "email" },
        cc: { type: "string", format: "email" },
        subject: { type: "string" },
      },
      required: ["to", "cc", "subject"],
    };
    let validatedArgs: JsonValue | undefined;

    await expect(
      validateEdits(
        payload,
        [{ pointer: "/subject", value: "Changed" }],
        schema,
        identityTokenizer,
        async (args) => {
          validatedArgs = args;
          return true;
        },
      ),
    ).resolves.toMatchObject({ subject: "Changed" });
    expect(validatedArgs).toEqual({
      to: "<EMAIL_1>",
      cc: "<EMAIL_2>",
      subject: "Changed",
    });
  });

  it("explicitly skips tool-schema validation when no input schema is available", async () => {
    await expect(
      validateEdits(
        createPayload(),
        [{ pointer: "/subject", value: "valid" }],
        undefined,
        identityTokenizer,
      ),
    ).resolves.toMatchObject({ subject: "valid" });
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
      rule: { ...rule, editable: ["/safe~1key", "/items"] },
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
      rule: { ...rule, editable: [""] },
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
      now: 100,
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
