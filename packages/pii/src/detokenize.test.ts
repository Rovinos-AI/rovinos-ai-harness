// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PiiConfigSchema, type JsonValue } from "@harness/schemas";
import { AuditingVaultResolver, InMemoryVault, type VaultAudit } from "@harness/vault";
import { detokenizeArgs, PiiTokenUnresolvableError } from "./detokenize.js";

const runId = "00000000000000000000000001";

function config(args: string[], onUnresolvable?: "fail" | "leave") {
  return PiiConfigSchema.parse({
    detokenize: [
      {
        toolId: "mail.send",
        args,
        ...(onUnresolvable === undefined ? {} : { onUnresolvable }),
      },
    ],
  });
}

describe("detokenizeArgs", () => {
  it("resolves only allowlisted pointers into a detached deep copy", async () => {
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");
    const audits: VaultAudit[] = [];
    const resolver = new AuditingVaultResolver(vault, (audit) => {
      audits.push(audit);
    });
    const args = {
      to: `Send to ${token}`,
      metadata: { token },
    } satisfies JsonValue;
    const original = structuredClone(args);

    const result = await detokenizeArgs(runId, "mail.send", args, config(["/to"]), resolver);

    expect(result).toEqual({
      args: { to: "Send to alice@example.test", metadata: { token } },
      resolvedCount: 1,
    });
    expect(args).toEqual(original);
    expect(result.args).not.toBe(args);
    if (typeof result.args !== "object" || result.args === null || Array.isArray(result.args)) {
      throw new Error("Expected a JSON object");
    }
    expect(result.args.metadata).not.toBe(args.metadata);
    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "detokenized",
        toolId: "mail.send",
        entities: [{ type: "email", count: 1 }],
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain("alice@example.test");
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("resolves tokens at wildcard array elements", async () => {
    const vault = new InMemoryVault();
    const first = await vault.put(runId, "email", "alice@example.test");
    const second = await vault.put(runId, "email", "bob@example.test");
    const resolver = new AuditingVaultResolver(vault, () => undefined);
    const args: JsonValue = { recipients: [{ address: first }, { address: second }] };

    const result = await detokenizeArgs(
      runId,
      "mail.send",
      args,
      config(["/recipients/*/address"]),
      resolver,
    );

    expect(result.args).toEqual({
      recipients: [{ address: "alice@example.test" }, { address: "bob@example.test" }],
    });
    expect(result.resolvedCount).toBe(2);
  });

  it("supports a concrete array index", async () => {
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");
    const resolver = new AuditingVaultResolver(vault, () => undefined);

    await expect(
      detokenizeArgs(
        runId,
        "mail.send",
        { recipients: ["public@example.test", token] },
        config(["/recipients/1"]),
        resolver,
      ),
    ).resolves.toEqual({
      args: { recipients: ["public@example.test", "alice@example.test"] },
      resolvedCount: 1,
    });
  });

  it("does not treat a wildcard as an object key or follow missing and invalid array indexes", async () => {
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", "alice@example.test");
    const audits: VaultAudit[] = [];
    const resolver = new AuditingVaultResolver(vault, (audit) => {
      audits.push(audit);
    });
    const args: JsonValue = {
      recipients: { "*": token },
      indexes: [token],
      message: "No token here",
      nullable: null,
    };

    const result = await detokenizeArgs(
      runId,
      "mail.send",
      args,
      config([
        "/recipients/*",
        "/indexes/01",
        "/indexes/2",
        "/indexes/9999999999999999999999",
        "/missing",
        "/nullable/inner",
        "/message",
      ]),
      resolver,
    );

    expect(result).toEqual({ args, resolvedCount: 0 });
    expect(audits).toEqual([]);
  });

  it("returns an unchanged detached copy when the tool has no allowlist entry", async () => {
    const args: JsonValue = { to: "<EMAIL_1>" };
    const resolver = new AuditingVaultResolver(new InMemoryVault(), () => undefined);

    const result = await detokenizeArgs(runId, "mail.read", args, config(["/to"]), resolver);

    expect(result).toEqual({ args, resolvedCount: 0 });
    expect(result.args).not.toBe(args);
  });

  it("fails with a value-free code when a token is unresolvable by default", async () => {
    const audits: VaultAudit[] = [];
    const resolver = new AuditingVaultResolver(new InMemoryVault(), (audit) => {
      audits.push(audit);
    });
    const token = "<EMAIL_9>";

    await expect(
      detokenizeArgs(runId, "mail.send", { to: token }, config(["/to"]), resolver),
    ).rejects.toMatchObject({ code: "pii_token_unresolvable" });

    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "blocked",
        toolId: "mail.send",
        entities: [{ type: "email", count: 1 }],
      },
    ]);
    expect(new PiiTokenUnresolvableError().message).not.toContain(token);
  });

  it("leaves unresolvable tokens unchanged when configured", async () => {
    const audits: VaultAudit[] = [];
    const resolver = new AuditingVaultResolver(new InMemoryVault(), (audit) => {
      audits.push(audit);
    });
    const token = "<EMAIL_9>";

    const result = await detokenizeArgs(
      runId,
      "mail.send",
      { to: token },
      config(["/to"], "leave"),
      resolver,
    );

    expect(result).toEqual({ args: { to: token }, resolvedCount: 0 });
    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "blocked",
        toolId: "mail.send",
        entities: [{ type: "email", count: 1 }],
      },
    ]);
  });
});
