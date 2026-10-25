// SPDX-License-Identifier: Apache-2.0
import { Code, Id, SecretRefSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import {
  ApprovalNotificationSchema,
  LogNotifier,
  WebhookNotificationError,
  WebhookNotifier,
} from "./notifier.js";

const notification = {
  runId: Id.parse("00000000000000000000000001"),
  approvalId: Id.parse("00000000000000000000000002"),
  idempotencyKey: Id.parse("00000000000000000000000002"),
  toolId: Code.parse("mail.send"),
  ruleId: Code.parse("mail.ask"),
  ageMs: 500,
};

describe("approval notifiers", () => {
  it("validates and logs metadata-only notifications", async () => {
    const received: (typeof notification)[] = [];
    const notifier = new LogNotifier((value) => received.push(value));

    await notifier.notify(notification);

    expect(received).toEqual([notification]);
    expect(() =>
      ApprovalNotificationSchema.parse({ ...notification, args: { recipient: "private" } }),
    ).toThrow();
    expect(() =>
      ApprovalNotificationSchema.parse({
        ...notification,
        idempotencyKey: Id.parse("00000000000000000000000003"),
      }),
    ).toThrow();
  });

  it("posts a strict notification body to the secret-resolved URL", async () => {
    const bodies: string[] = [];
    const idempotencyKeys: (string | null)[] = [];
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: {
        resolve: (ref) => {
          expect(ref).toBe("env:APPROVAL_WEBHOOK");
          return Promise.resolve("https://hooks.example.test/approval");
        },
      },
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON body.");
        }
        bodies.push(init.body);
        idempotencyKeys.push(new Headers(init.headers).get("Idempotency-Key"));
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await notifier.notify(notification);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(JSON.stringify(notification));
    expect(idempotencyKeys).toEqual([notification.approvalId]);
    expect(bodies[0]).not.toContain("args");
  });

  it("allows localhost HTTP for a URL SecretRef only when explicitly enabled", async () => {
    let calls = 0;
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      allowInsecureLocalhost: true,
      secrets: { resolve: () => Promise.resolve("http://localhost:8080/approval") },
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await notifier.notify(notification);

    expect(calls).toBe(1);
  });

  it("rejects localhost HTTP for both URL forms without explicit opt-in", async () => {
    let calls = 0;
    const secretUrlNotifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("http://localhost:8080/approval") },
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await expect(secretUrlNotifier.notify(notification)).rejects.toMatchObject({
      code: "approval_webhook_failed",
    });
    expect(
      () =>
        new WebhookNotifier({
          url: "http://localhost:8080/approval",
          secretRef: SecretRefSchema.parse("env:APPROVAL_WEBHOOK_TOKEN"),
          secrets: { resolve: () => Promise.resolve("token") },
          fetch: () => {
            calls += 1;
            return Promise.resolve(new Response(null, { status: 204 }));
          },
        }),
    ).toThrow(WebhookNotificationError);
    expect(calls).toBe(0);
  });

  it("retries one failed request and rejects after two failures", async () => {
    let calls = 0;
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("https://hooks.example.test/approval") },
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: calls === 1 ? 503 : 204 }));
      },
    });

    await notifier.notify(notification);
    expect(calls).toBe(2);

    calls = 0;
    const unavailable = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("https://hooks.example.test/approval") },
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 503 }));
      },
    });
    await expect(unavailable.notify(notification)).rejects.toBeInstanceOf(WebhookNotificationError);
    expect(calls).toBe(2);
  });

  it("rejects redirect responses rather than following another host", async () => {
    let calls = 0;
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("https://hooks.example.test/approval") },
      fetch: (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe("error");
        return Promise.reject(new TypeError("Redirect rejected."));
      },
    });

    await expect(notifier.notify(notification)).rejects.toMatchObject({
      code: "approval_webhook_failed",
    });
    expect(calls).toBe(2);
  });

  it("rejects invalid SecretRefs and resolved webhook URLs without exposing them", async () => {
    const notifier = new WebhookNotifier({
      url: SecretRefSchema.parse("env:APPROVAL_WEBHOOK"),
      secrets: { resolve: () => Promise.resolve("file:///private/webhook") },
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    await expect(notifier.notify(notification)).rejects.toMatchObject({
      code: "approval_webhook_failed",
    });
    expect(() => SecretRefSchema.parse("https://inline.example.test")).toThrow();
  });
});
