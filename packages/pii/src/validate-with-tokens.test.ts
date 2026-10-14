// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@harness/schemas";
import { AuditingVaultResolver, InMemoryVault, type VaultAudit } from "@harness/vault";
import { z } from "zod";
import { validateWithTokens } from "./validate-with-tokens.js";

const runId = "00000000000000000000000001";

function makeResolver(vault = new InMemoryVault()) {
  const audits: VaultAudit[] = [];
  return {
    audits,
    resolver: new AuditingVaultResolver(vault, (audit) => {
      audits.push(audit);
    }),
    vault,
  };
}

describe("validateWithTokens", () => {
  it("validates tokenized email data while returning the unchanged tokenized value", async () => {
    const { audits, resolver, vault } = makeResolver();
    const token = await vault.put(runId, "email", "alice@example.test");
    const tokenized: JsonValue = { email: token };
    const original = structuredClone(tokenized);
    const schema = z.object({ email: z.string().email() }).strict();

    const result = await validateWithTokens(schema, tokenized, { runId, resolver });

    expect(result).toEqual({ ok: true, tokenized });
    if (!result.ok) {
      throw new Error("Expected the email token to validate.");
    }
    expect(result.tokenized).toEqual(original);
    expect(tokenized).toEqual(original);
    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "detokenized",
        entities: [{ type: "email", count: 1 }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("alice@example.test");
    expect(JSON.stringify(audits)).not.toContain("alice@example.test");
  });

  it("reports schema paths and codes without returning an invalid raw value", async () => {
    const { resolver, vault } = makeResolver();
    const raw = "not-an-email-canary";
    const token = await vault.put(runId, "email", raw);
    const result = await validateWithTokens(
      z.object({ email: z.string().email() }),
      { email: token },
      { runId, resolver },
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["email"], code: "invalid_format" }],
    });
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it("fails closed with the unresolvable code and a value-free audit", async () => {
    const { audits, resolver } = makeResolver();
    const token = "<EMAIL_9>";

    const result = await validateWithTokens(z.string().email(), token, { runId, resolver });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: [], code: "pii_token_unresolvable" }],
    });
    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "blocked",
        entities: [{ type: "email", count: 1 }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("returns parsed raw data only when requested and audits resolution", async () => {
    const { audits, resolver, vault } = makeResolver();
    const raw = "alice@example.test";
    const token = await vault.put(runId, "email", raw);
    const tokenized: JsonValue = { email: token };

    const result = await validateWithTokens(
      z.object({ email: z.string().email() }),
      tokenized,
      { runId, resolver, wantRaw: true },
    );

    expect(result).toEqual({ ok: true, tokenized, raw: { email: raw } });
    expect(audits).toMatchObject([
      { boundary: "tool_input", action: "detokenized", entities: [{ type: "email", count: 1 }] },
    ]);
    expect(JSON.stringify(audits)).not.toContain(raw);
  });

  it("resolves tokens in nested JSON strings without mutating the input", async () => {
    const { resolver, vault } = makeResolver();
    const first = await vault.put(runId, "email", "alice@example.test");
    const second = await vault.put(runId, "email", "bob@example.test");
    const tokenized: JsonValue = {
      entries: [{ email: first, note: `Send ${first} or ${second}`, untouched: 7 }],
    };
    const schema = z.object({
      entries: z.array(z.object({ email: z.string().email(), note: z.string(), untouched: z.number() })),
    });

    const result = await validateWithTokens(schema, tokenized, {
      runId,
      resolver,
      wantRaw: true,
    });

    expect(result).toEqual({
      ok: true,
      tokenized,
      raw: {
        entries: [
          {
            email: "alice@example.test",
            note: "Send alice@example.test or bob@example.test",
            untouched: 7,
          },
        ],
      },
    });
    expect(tokenized).toEqual({
      entries: [{ email: first, note: `Send ${first} or ${second}`, untouched: 7 }],
    });
  });

  it("converts resolver failures into a safe unresolvable issue", async () => {
    const { resolver, vault } = makeResolver();
    const token = await vault.put(runId, "email", "resolver-failure-canary@example.test");
    vi.spyOn(vault, "resolve").mockRejectedValue(new Error("resolver-failure-canary@example.test"));

    const result = await validateWithTokens(z.string().email(), token, { runId, resolver });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: [], code: "pii_token_unresolvable" }],
    });
    expect(JSON.stringify(result)).not.toContain("resolver-failure-canary@example.test");
  });

  it("returns a generic issue if the schema throws instead of exposing its error", async () => {
    const { resolver } = makeResolver();
    const rawCanary = "schema-failure-canary@example.test";
    const schema = z.string().refine(() => {
      throw new Error(rawCanary);
    });

    const result = await validateWithTokens(schema, "plain", { runId, resolver });

    expect(result).toEqual({ ok: false, issues: [{ path: [], code: "custom" }] });
    expect(JSON.stringify(result)).not.toContain(rawCanary);
  });
});
