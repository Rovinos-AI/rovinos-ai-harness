// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { ArgMatcherSchema, loadPolicy, PolicyDocumentSchema, policyVersion } from "./index.js";

const validYaml = `
version: 1
defaultDecision: ask
rules:
  - id: ask_email_send
    description: Ask before sending to a tokenized email address
    match:
      tools:
        - mail.send
      args:
        - pointer: /to
          op: tokenType
          value: email
    decision: ask
    reason: outbound_email
    editable:
      - /subject
    approvalTtlMs: 300000
    escalateAfterMs: 60000
`;

describe("PolicyDocumentSchema", () => {
  it("accepts the documented YAML policy", () => {
    expect(parseYaml(PolicyDocumentSchema, validYaml)).toMatchObject({
      version: 1,
      defaultDecision: "ask",
      rules: [{ match: { args: [{ op: "tokenType", value: "email" }] }, decision: "ask" }],
    });
  });

  it("rejects default allow", () => {
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "allow", rules: [] }).success,
    ).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    const rule = { id: "same", match: { tools: "mail.send" }, decision: "deny", reason: "blocked" };
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "deny", rules: [rule, rule] })
        .success,
    ).toBe(false);
  });

  it.each([
    {
      id: "allow_all",
      match: { tools: "*" },
      decision: "allow",
      reason: "bad",
    },
    {
      id: "allow_all_array",
      match: { tools: ["*"] },
      decision: "allow",
      reason: "bad",
    },
    {
      id: "editable_allow",
      match: { tools: "mail.send" },
      decision: "allow",
      reason: "bad",
      editable: ["/to"],
    },
    {
      id: "escalate_deny",
      match: { tools: "mail.send" },
      decision: "deny",
      reason: "bad",
      escalateAfterMs: 10,
    },
  ])("rejects unsafe rule $id", (rule) => {
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "deny", rules: [rule] })
        .success,
    ).toBe(false);
  });

  it.each(["mail.*", "*", ["mail.send", "fs.*"]])("accepts tool pattern %s", (tools) => {
    expect(
      PolicyDocumentSchema.safeParse({
        version: 1,
        defaultDecision: "deny",
        rules: [{ id: "valid", match: { tools }, decision: "deny", reason: "blocked" }],
      }).success,
    ).toBe(true);
  });

  it.each(["mail.*.send", "mail.*send", "*.*", "mail.**", "bad~pattern"])(
    "rejects invalid tool pattern %s",
    (tools) => {
      expect(
        PolicyDocumentSchema.safeParse({
          version: 1,
          defaultDecision: "deny",
          rules: [{ id: "invalid", match: { tools }, decision: "deny", reason: "blocked" }],
        }).success,
      ).toBe(false);
    },
  );

  it.each(["", "/valid~1pointer", "/valid~0pointer"])("accepts JSON Pointer %s", (pointer) => {
    expect(ArgMatcherSchema.safeParse({ pointer, op: "exists" }).success).toBe(true);
  });

  it.each(["not/a/pointer", "/bad~2escape", "/bad~"])(
    "rejects invalid JSON Pointer %s",
    (pointer) => {
      expect(ArgMatcherSchema.safeParse({ pointer, op: "exists" }).success).toBe(false);
    },
  );

  it("rejects unsafe and syntactically invalid matches expressions", () => {
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "matches", value: "(a+)+$" }).success,
    ).toBe(false);
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "matches", value: "[" }).success,
    ).toBe(false);
  });

  it("requires operation-specific values and strict object keys", () => {
    expect(ArgMatcherSchema.safeParse({ pointer: "/value", op: "equals" }).success).toBe(false);
    expect(ArgMatcherSchema.safeParse({ pointer: "/value", op: "in", value: "x" }).success).toBe(
      false,
    );
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "startsWith", value: 1 }).success,
    ).toBe(false);
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "exists", extra: true }).success,
    ).toBe(false);
  });
});

describe("loadPolicy and policyVersion", () => {
  it("loads YAML and JSON policy files from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "policy-schema-"));
    try {
      const yamlPath = join(directory, "policy.yaml");
      const jsonPath = join(directory, "policy.json");
      await writeFile(yamlPath, validYaml);
      await writeFile(jsonPath, JSON.stringify(parseYaml(PolicyDocumentSchema, validYaml)));
      await expect(loadPolicy(yamlPath)).resolves.toEqual(
        parseYaml(PolicyDocumentSchema, validYaml),
      );
      await expect(loadPolicy(jsonPath)).resolves.toEqual(
        parseYaml(PolicyDocumentSchema, validYaml),
      );
      await writeFile(
        yamlPath,
        `version: 1\ndefaultDecision: deny\nrules:\n  - id: allow_all\n    match:\n      tools: "*"\n    decision: allow\n    reason: unsafe\n`,
      );
      await expect(loadPolicy(yamlPath)).rejects.toMatchObject({ code: "contract_invalid" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("produces the same policy version regardless of object key order", () => {
    const first = parseYaml(PolicyDocumentSchema, validYaml);
    const second = {
      rules: first.rules.map((rule) => ({
        reason: rule.reason,
        decision: rule.decision,
        match: {
          args: rule.match.args?.map((matcher) => ({
            value: matcher.value,
            op: matcher.op,
            pointer: matcher.pointer,
          })),
          tools: rule.match.tools,
        },
        id: rule.id,
        description: rule.description,
        editable: rule.editable,
        approvalTtlMs: rule.approvalTtlMs,
        escalateAfterMs: rule.escalateAfterMs,
      })),
      defaultDecision: first.defaultDecision,
      version: first.version,
    };
    expect(policyVersion(first)).toBe(policyVersion(second));
    expect(policyVersion(first)).toMatch(/^pol-[0-9a-f]{12}$/u);
  });
});
