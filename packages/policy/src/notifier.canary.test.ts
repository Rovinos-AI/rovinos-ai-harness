// SPDX-License-Identifier: Apache-2.0
import { Code, Id, SecretRefSchema, parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { ApprovalNotificationSchema, WebhookNotifier } from "./notifier.js";

describe("approval webhook privacy canary", () => {
  it("serializes only approval metadata and never includes arguments", async () => {
    let body = "";
    let idempotencyKey: string | null = null;
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("https://hooks.example.test/approval") },
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected serialized notification metadata.");
        }
        body = init.body;
        idempotencyKey = new Headers(init.headers).get("Idempotency-Key");
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await notifier.notify({
      runId: Id.parse("00000000000000000000000001"),
      approvalId: Id.parse("00000000000000000000000002"),
      idempotencyKey: Id.parse("00000000000000000000000002"),
      toolId: Code.parse("mail.send"),
      ruleId: Code.parse("mail.ask"),
      ageMs: 5_000,
    });

    const parsed = parseJson(ApprovalNotificationSchema, body);
    expect(Object.keys(parsed).sort()).toEqual([
      "ageMs",
      "approvalId",
      "idempotencyKey",
      "ruleId",
      "runId",
      "toolId",
    ]);
    expect(parsed.idempotencyKey).toBe(parsed.approvalId);
    expect(idempotencyKey).toBe(parsed.approvalId);
    expect(body).not.toContain("ARGS_PRIVACY_CANARY");
  });
});
