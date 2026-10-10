// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { AuditingVaultResolver } from "./auditing-resolver.js";
import { InMemoryVault } from "./memory.js";
import type { VaultResolver } from "./types.js";

const runId = "00000000000000000000000001";
const context = { boundary: "tool_input" as const, toolId: "mail.send" };

describe("AuditingVaultResolver", () => {
  it("audits each successful resolution without exposing the token or value", async () => {
    const inner = new InMemoryVault();
    const token = await inner.put(runId, "email", "alice@example.test");
    const onAudit = vi.fn();
    const resolver = new AuditingVaultResolver(inner, onAudit);

    await expect(resolver.resolve(runId, token, context)).resolves.toBe("alice@example.test");

    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit).toHaveBeenCalledWith({
      runId,
      boundary: "tool_input",
      action: "detokenized",
      toolId: "mail.send",
      entities: [{ type: "email", count: 1 }],
    });
    const payload = JSON.stringify(onAudit.mock.calls[0]);
    expect(payload).not.toContain(token);
    expect(payload).not.toContain("alice@example.test");
  });

  it("aggregates entity counts in one audit per batch and distinguishes UI reveals", async () => {
    const inner = new InMemoryVault();
    const email1 = await inner.put(runId, "email", "alice@example.test");
    const email2 = await inner.put(runId, "email", "bob@example.test");
    const phone = await inner.put(runId, "phone", "5550100000");
    const onAudit = vi.fn();
    const resolver = new AuditingVaultResolver(inner, onAudit);

    await expect(
      resolver.resolveMany(runId, [email1, email2, phone], { boundary: "ui" }),
    ).resolves.toEqual(["alice@example.test", "bob@example.test", "5550100000"]);

    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit).toHaveBeenCalledWith({
      runId,
      boundary: "ui",
      action: "detokenized",
      entities: [
        { type: "email", count: 2 },
        { type: "phone", count: 1 },
      ],
    });
  });

  it("audits unknown tokens as blocked and separates partial batch outcomes", async () => {
    const inner = new InMemoryVault();
    const email = await inner.put(runId, "email", "alice@example.test");
    const onAudit = vi.fn();
    const resolver = new AuditingVaultResolver(inner, onAudit);

    await expect(resolver.resolveMany(runId, [email, "<PHONE_7>"], context)).resolves.toEqual([
      "alice@example.test",
      undefined,
    ]);

    expect(onAudit).toHaveBeenCalledTimes(2);
    expect(onAudit).toHaveBeenCalledWith({
      runId,
      boundary: "tool_input",
      action: "detokenized",
      toolId: "mail.send",
      entities: [{ type: "email", count: 1 }],
    });
    expect(onAudit).toHaveBeenCalledWith({
      runId,
      boundary: "tool_input",
      action: "blocked",
      toolId: "mail.send",
      entities: [{ type: "phone", count: 1 }],
    });
    expect(JSON.stringify(onAudit.mock.calls)).not.toContain(email);
    expect(JSON.stringify(onAudit.mock.calls)).not.toContain("alice@example.test");
  });

  it("emits no audit for an empty batch", async () => {
    const onAudit = vi.fn();
    const resolver = new AuditingVaultResolver(new InMemoryVault(), onAudit);

    await expect(resolver.resolveMany(runId, [], context)).resolves.toEqual([]);
    expect(onAudit).not.toHaveBeenCalled();
  });

  it("preserves resolver errors after auditing any successful batch entries", async () => {
    const inner = new InMemoryVault();
    const token = await inner.put(runId, "email", "alice@example.test");
    const brokenResolver: VaultResolver = {
      resolve: () => Promise.reject(new Error("resolver unavailable")),
    };
    const onAudit = vi.fn();
    const resolver = new AuditingVaultResolver(
      {
        resolve: async (id, requestedToken, requestContext) => {
          if (requestedToken === token) {
            return inner.resolve(id, requestedToken, requestContext);
          }
          return brokenResolver.resolve(id, requestedToken, requestContext);
        },
      },
      onAudit,
    );

    await expect(resolver.resolveMany(runId, [token, "<EMAIL_2>"], context)).rejects.toThrow(
      "resolver unavailable",
    );
    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "detokenized", entities: [{ type: "email", count: 1 }] }),
    );
  });
});
