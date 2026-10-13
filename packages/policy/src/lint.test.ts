// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ArgMatcher, PolicyDocument, Rule } from "./schema.js";
import { lintPolicy } from "./lint.js";

const cleanPolicy: PolicyDocument = {
  version: 1,
  defaultDecision: "deny",
  rules: [
    {
      id: "allow_mail_read",
      match: { tools: ["mail.read"] },
      decision: "allow",
      reason: "read_only",
    },
  ],
};

describe("lintPolicy", () => {
  it("passes a valid policy with unique matchers", () => {
    expect(lintPolicy(cleanPolicy)).toEqual({ diagnostics: [] });
  });

  it("reports duplicate matchers, stricter earlier shadowing, and allows denied by a deny rule", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_path",
          match: { tools: ["fs.write"], args: [{ pointer: "/path", op: "equals", value: "x" }] },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "ask_same_path",
          match: { tools: ["fs.write"], args: [{ pointer: "/path", op: "equals", value: "x" }] },
          decision: "ask",
          reason: "approval",
        },
        {
          id: "allow_same_path",
          match: { tools: ["fs.write"], args: [{ pointer: "/path", op: "equals", value: "x" }] },
          decision: "allow",
          reason: "allowed",
        },
      ],
    };

    expect(lintPolicy(document).diagnostics).toEqual([
      { severity: "error", code: "duplicate_matcher", ruleId: "ask_same_path" },
      { severity: "error", code: "rule_shadowed", ruleId: "ask_same_path" },
      { severity: "error", code: "duplicate_matcher", ruleId: "allow_same_path" },
      { severity: "error", code: "rule_shadowed", ruleId: "allow_same_path" },
      { severity: "error", code: "allow_fully_denied", ruleId: "allow_same_path" },
    ]);
  });

  it("reports broad allow rules and unused editable pointers when tool metadata is available", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "allow_fs",
          match: { tools: ["fs.*"] },
          decision: "allow",
          reason: "filesystem_access",
        },
        {
          id: "ask_edit",
          match: { tools: ["editor.apply"] },
          decision: "ask",
          reason: "human_review",
          editable: ["/missing"],
        },
      ],
    };
    const metadata = [
      {
        toolId: "fs.delete",
        destructive: true,
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        toolId: "editor.apply",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    ];

    expect(lintPolicy(document, metadata).diagnostics).toEqual([
      { severity: "error", code: "allow_destructive_wildcard", ruleId: "allow_fs" },
      { severity: "error", code: "unused_editable_pointer", ruleId: "ask_edit" },
    ]);
  });

  it("does not flag editable pointers that exist in available tool schemas", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "ask_edit",
          match: { tools: ["editor.apply"] },
          decision: "ask",
          reason: "human_review",
          editable: ["/details/title"],
        },
      ],
    };

    expect(
      lintPolicy(document, [
        {
          toolId: "editor.apply",
          inputSchema: {
            type: "object",
            properties: {
              details: { type: "object", properties: { title: { type: "string" } } },
            },
          },
        },
      ]),
    ).toEqual({ diagnostics: [] });
  });

  it("reports missing reason without returning policy text", () => {
    const result = lintPolicy({
      version: 1,
      defaultDecision: "deny",
      rules: [{ id: "missing_reason_rule", match: { tools: ["fs.read"] }, decision: "deny" }],
    });

    expect(result.diagnostics).toContainEqual({
      severity: "error",
      code: "missing_reason",
      ruleId: "missing_reason_rule",
    });
    expect(result.diagnostics).toContainEqual({
      severity: "error",
      code: "policy_invalid",
    });
    expect(JSON.stringify(result)).not.toContain("policy text");
  });

  it("reports invalid policy data and ignores malformed optional metadata safely", () => {
    expect(lintPolicy({ version: 1, defaultDecision: "allow", rules: [] }).diagnostics).toEqual([
      { severity: "error", code: "policy_invalid" },
    ]);
    expect(lintPolicy(cleanPolicy, [{ toolId: "bad metadata" }]).diagnostics).toEqual([
      { severity: "warning", code: "policy_metadata_invalid" },
    ]);
  });

  it("does not infer complete rule coverage from incompatible context or matcher constraints", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_subagent",
          match: { tools: ["fs.*"], context: { subagent: true } },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "allow_host",
          match: {
            tools: ["fs.write"],
            args: [{ pointer: "/path", op: "startsWith", value: "/tmp" }],
            context: { subagent: false },
          },
          decision: "allow",
          reason: "allowed",
        },
      ],
    };

    expect(lintPolicy(document)).toEqual({ diagnostics: [] });
  });

  it("recognizes exact-value implications for each supported matcher operation", () => {
    const cases: readonly { readonly cover: ArgMatcher; readonly candidate: ArgMatcher }[] = [
      {
        cover: { pointer: "/value", op: "equals", value: "exact" },
        candidate: { pointer: "/value", op: "in", value: ["exact"] },
      },
      {
        cover: { pointer: "/value", op: "in", value: ["one", "two"] },
        candidate: { pointer: "/value", op: "equals", value: "one" },
      },
      {
        cover: { pointer: "/value", op: "startsWith", value: "prefix" },
        candidate: { pointer: "/value", op: "equals", value: "prefix-value" },
      },
      {
        cover: { pointer: "/value", op: "matches", value: "^prefix" },
        candidate: { pointer: "/value", op: "in", value: ["prefix-one", "prefix-two"] },
      },
      {
        cover: { pointer: "/value", op: "tokenType", value: "email" },
        candidate: { pointer: "/value", op: "equals", value: "<EMAIL_1>" },
      },
    ];

    for (const [index, { cover, candidate }] of cases.entries()) {
      const document: PolicyDocument = {
        version: 1,
        defaultDecision: "deny",
        rules: [
          {
            id: `deny_${String(index)}`,
            match: { tools: ["test.call"], args: [cover] },
            decision: "deny",
            reason: "blocked",
          },
          {
            id: `allow_${String(index)}`,
            match: { tools: ["test.call"], args: [candidate] },
            decision: "allow",
            reason: "allowed",
          },
        ],
      };

      expect(lintPolicy(document).diagnostics).toContainEqual({
        severity: "error",
        code: "allow_fully_denied",
        ruleId: `allow_${String(index)}`,
      });
    }
  });

  it("compares nested JSON matcher values and canonicalizes duplicate matcher keys", () => {
    const left = { nested: [1, { value: true }], object: { first: "a", second: "b" } };
    const right = { object: { second: "b", first: "a" }, nested: [1, { value: true }] };
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_json",
          match: { tools: ["test.call"], args: [{ pointer: "/value", op: "equals", value: left }] },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "allow_json",
          match: {
            tools: ["test.call"],
            args: [{ pointer: "/value", op: "equals", value: right }],
          },
          decision: "allow",
          reason: "allowed",
        },
      ],
    };

    expect(lintPolicy(document).diagnostics).toEqual([
      { severity: "error", code: "duplicate_matcher", ruleId: "allow_json" },
      { severity: "error", code: "rule_shadowed", ruleId: "allow_json" },
      { severity: "error", code: "allow_fully_denied", ruleId: "allow_json" },
    ]);
  });

  it("handles wildcard tool containment and equivalent calling context", () => {
    const rules: readonly Rule[] = [
      {
        id: "deny_fs",
        match: { tools: ["fs.*"], context: { subagent: true } },
        decision: "deny",
        reason: "blocked",
      },
      {
        id: "ask_nested_fs",
        match: { tools: ["fs.file.*"], context: { subagent: true } },
        decision: "ask",
        reason: "approval",
      },
      {
        id: "ask_all",
        match: { tools: "*", context: { subagent: false } },
        decision: "ask",
        reason: "approval",
      },
    ];

    expect(lintPolicy({ version: 1, defaultDecision: "deny", rules }).diagnostics).toContainEqual({
      severity: "error",
      code: "rule_shadowed",
      ruleId: "ask_nested_fs",
    });
    expect(
      lintPolicy({ version: 1, defaultDecision: "deny", rules }).diagnostics,
    ).not.toContainEqual({ severity: "error", code: "rule_shadowed", ruleId: "ask_all" });
  });

  it("handles global and exact tool patterns without overclaiming wildcard containment", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_specific",
          match: { tools: ["fs.read"] },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "ask_everything",
          match: { tools: "*" },
          decision: "ask",
          reason: "approval",
        },
        {
          id: "ask_specific",
          match: { tools: ["fs.read"] },
          decision: "ask",
          reason: "approval",
        },
      ],
    };

    expect(lintPolicy(document).diagnostics).toContainEqual({
      severity: "error",
      code: "rule_shadowed",
      ruleId: "ask_specific",
    });
    expect(lintPolicy(document).diagnostics).not.toContainEqual({
      severity: "error",
      code: "rule_shadowed",
      ruleId: "ask_everything",
    });
    expect(
      lintPolicy({
        version: 1,
        defaultDecision: "deny",
        rules: [
          {
            id: "deny_everything",
            match: { tools: "*" },
            decision: "deny",
            reason: "blocked",
          },
          {
            id: "ask_one",
            match: { tools: ["fs.read"] },
            decision: "ask",
            reason: "approval",
          },
        ],
      }).diagnostics,
    ).toContainEqual({ severity: "error", code: "rule_shadowed", ruleId: "ask_one" });
  });

  it("handles exists and pointer-mismatched argument matchers", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "deny_present",
          match: { tools: ["test.call"], args: [{ pointer: "/value", op: "exists" }] },
          decision: "deny",
          reason: "blocked",
        },
        {
          id: "allow_present",
          match: { tools: ["test.call"], args: [{ pointer: "/value", op: "exists" }] },
          decision: "allow",
          reason: "allowed",
        },
        {
          id: "allow_other_pointer",
          match: { tools: ["test.call"], args: [{ pointer: "/other", op: "equals", value: "x" }] },
          decision: "allow",
          reason: "allowed",
        },
      ],
    };

    expect(lintPolicy(document).diagnostics).toContainEqual({
      severity: "error",
      code: "allow_fully_denied",
      ruleId: "allow_present",
    });
    expect(lintPolicy(document).diagnostics).not.toContainEqual({
      severity: "error",
      code: "allow_fully_denied",
      ruleId: "allow_other_pointer",
    });
  });

  it("only diagnoses editable pointers when available metadata can establish non-use", () => {
    const document: PolicyDocument = {
      version: 1,
      defaultDecision: "deny",
      rules: [
        {
          id: "ask_edit",
          match: { tools: ["editor.apply"] },
          decision: "ask",
          reason: "human_review",
          editable: ["/items/0/name", "/missing"],
        },
      ],
    };
    const diagnostics = lintPolicy(document, [
      {
        toolId: "editor.apply",
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "object", properties: { name: {} } } },
          },
        },
      },
      {
        toolId: "editor.other",
        inputSchema: { type: "object", properties: { missing: {} } },
      },
    ]).diagnostics;

    expect(diagnostics).toEqual([
      { severity: "error", code: "unused_editable_pointer", ruleId: "ask_edit" },
    ]);
    expect(
      lintPolicy(document, [{ toolId: "editor.apply", inputSchema: { $ref: "#/$defs/unknown" } }])
        .diagnostics,
    ).toEqual([]);
    expect(lintPolicy(document, [{ toolId: "editor.apply" }]).diagnostics).toEqual([]);
    expect(lintPolicy(document, [{ toolId: "different.tool" }]).diagnostics).toEqual([]);
    expect(
      lintPolicy(
        {
          ...document,
          rules: [
            {
              ...document.rules[0],
              editable: ["", "/null/inside"],
            },
          ],
        },
        [
          {
            toolId: "editor.apply",
            inputSchema: {
              type: "object",
              properties: { null: null },
            },
          },
        ],
      ).diagnostics,
    ).toEqual([{ severity: "error", code: "unused_editable_pointer", ruleId: "ask_edit" }]);
  });

  it("reports malformed required fields without trusting unvalidated rule identifiers", () => {
    expect(
      lintPolicy({
        version: 1,
        defaultDecision: "deny",
        rules: [{ id: "invalid id", match: { tools: ["test.call"] }, decision: "deny" }],
      }).diagnostics,
    ).toEqual([
      { severity: "error", code: "missing_reason" },
      { severity: "error", code: "policy_invalid" },
    ]);
    expect(
      lintPolicy({ version: 1, defaultDecision: "deny", rules: [{ id: "bad" }] }).diagnostics,
    ).toEqual([
      { severity: "error", code: "missing_reason", ruleId: "bad" },
      { severity: "error", code: "policy_invalid" },
    ]);
  });
});
