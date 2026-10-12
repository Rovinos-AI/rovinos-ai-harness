// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "./engine.js";
import { PolicyDocumentSchema } from "./schema.js";
import type { PolicyDocument } from "./schema.js";

const document: PolicyDocument = PolicyDocumentSchema.parse({
  version: 1,
  defaultDecision: "deny",
  rules: [
    {
      id: "read_rule",
      match: { tools: ["fs.read"], context: { subagent: false } },
      decision: "ask",
      reason: "needs_review",
    },
  ],
});

describe("PolicyEngine", () => {
  it("compiles once, exposes the document version, and decides using run context", async () => {
    const engine = new PolicyEngine(document);

    await expect(
      engine.decide(
        { toolId: "fs.read", args: { path: "<PATH_1>" } },
        { subagent: false },
      ),
    ).resolves.toMatchObject({
      decision: "ask",
      ruleId: "read_rule",
      reason: "needs_review",
    });
    expect(engine.version).toMatch(/^pol-[0-9a-f]{12}$/u);
  });

  it("uses the restrictive document default when no rule matches", async () => {
    const engine = new PolicyEngine(document);

    await expect(
      engine.decide({ toolId: "fs.write", args: null }, { subagent: false }),
    ).resolves.toMatchObject({ decision: "deny", ruleId: "default" });
  });
});
