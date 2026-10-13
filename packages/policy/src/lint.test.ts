// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { PolicyDocument } from "./schema.js";
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
});
