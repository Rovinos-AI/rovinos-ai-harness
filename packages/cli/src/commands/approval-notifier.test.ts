// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema, Secret } from "@harness/config";
import { LogNotifier, WebhookNotifier } from "@harness/policy";
import { Code, Id, type SecretRef } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { createApprovalNotifier } from "./approval-notifier.js";

const notification = {
  runId: Id.parse("00000000000000000000000001"),
  approvalId: Id.parse("00000000000000000000000002"),
  idempotencyKey: Id.parse("00000000000000000000000002"),
  toolId: Code.parse("mail.send"),
  ruleId: Code.parse("mail.ask"),
  ageMs: 500,
};

describe("createApprovalNotifier", () => {
  it("defaults to the log notifier", async () => {
    const write = vi.fn();
    const notifier = await createApprovalNotifier(undefined, undefined, write);

    await notifier.notify(notification);

    expect(notifier).toBeInstanceOf(LogNotifier);
    expect(write).toHaveBeenCalledWith(notification);
  });

  it("resolves webhook secrets through the resolver and sends metadata only", async () => {
    const secret = "APPROVAL_WEBHOOK_SECRET_CANARY";
    const config = HarnessConfigSchema.parse({
      policy: {
        approvals: {
          notifier: {
            kind: "webhook",
            url: "https://hooks.example.test/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
            timeoutMs: 2_000,
          },
        },
      },
    });
    const resolve = vi.fn((_ref: SecretRef) => Promise.resolve(new Secret(secret)));
    let body = "";
    let authorization: string | null = null;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      body = typeof init?.body === "string" ? init.body : "";
      authorization = new Headers(init?.headers).get("authorization");
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const notifier = await createApprovalNotifier(config.policy.approvals, { resolve }, vi.fn());

      expect(notifier).toBeInstanceOf(WebhookNotifier);
      if (!(notifier instanceof WebhookNotifier)) {
        throw new TypeError("Expected configured webhook notifier.");
      }
      await notifier.notify(notification);

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith("env:APPROVAL_WEBHOOK_TOKEN", expect.any(AbortSignal));
      expect(body).toBe(JSON.stringify(notification));
      expect(authorization).toBe("Bearer " + secret);
      expect(body).not.toContain(secret);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
