// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@harness/schemas";
import type { ModelToolCall, PolicyPort, RunContext, ToolPort } from "@harness/core";
import { PolicyEngine } from "@harness/policy";
import { createPolicyCheckedAppCallHandler, type AppCall } from "@harness/host";
import { describe, expect, it, vi } from "vitest";

const runId = Id.parse("00000000000000000000000001");
const appId = Code.parse("approval");
const call: AppCall = {
  appId,
  sessionId: Id.parse("00000000000000000000000002"),
  toolName: "approve",
  arguments: { value: "synthetic raw input" },
};
const context = { runId, policyContext: { subagent: false, app: appId } } as const;

function policy(decision: "allow" | "ask" | "deny", app = appId): PolicyPort {
  return new PolicyEngine({
    version: 1,
    defaultDecision: "deny",
    rules: [
      {
        id: "app_rule",
        match: {
          tools: ["approve"],
          context: { subagent: false, app },
          ...(decision === "allow"
            ? {
                args: [{ pointer: "/value", op: "equals" as const, value: "<PATH_1>" }],
              }
            : {}),
        },
        decision,
        reason: "app_rule_reason",
      },
    ],
  });
}

function tool() {
  const prepare = vi.fn((proposed: ModelToolCall) =>
    Promise.resolve({ ...proposed, args: { value: "<PATH_1>" } }),
  );
  const execute = vi.fn((_call: ModelToolCall, _context: RunContext) =>
    Promise.resolve({ outcome: "ok" as const, result: { completed: true } }),
  );
  const port: ToolPort = {
    prepare,
    describe: (toolId) =>
      toolId === "approve" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
    execute,
  };
  return { port, prepare, execute };
}

function handler(policyPort: PolicyPort, toolPort: ToolPort) {
  return createPolicyCheckedAppCallHandler({
    policy: policyPort,
    tool: toolPort,
    nextCallId: () => Id.parse("00000000000000000000000003"),
  });
}

describe("policy-checked app call handler", () => {
  it("prepares arguments, then blocks an app-scoped deny rule without execution", async () => {
    const tools = tool();
    const result = await handler(policy("deny"), tools.port)(call, context);

    expect(tools.prepare).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "app_rule_reason" }], isError: true });
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("executes an app-scoped allow rule using prepared arguments", async () => {
    const tools = tool();
    const result = await handler(policy("allow"), tools.port)(call, context);

    expect(result).toEqual({ content: [{ type: "text", text: '{"completed":true}' }] });
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ args: { value: "<PATH_1>" } }),
      expect.objectContaining({ runId }),
    );
  });

  it("does not execute an ask decision because app calls cannot suspend the run", async () => {
    const tools = tool();
    const result = await handler(policy("ask"), tools.port)(call, context);

    expect(result).toEqual({
      content: [{ type: "text", text: "app_call_requires_approval" }],
      isError: true,
    });
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("does not match a rule scoped to a different app", async () => {
    const tools = tool();
    const result = await handler(policy("allow", Code.parse("other_app")), tools.port)(
      call,
      context,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "default_decision" }],
      isError: true,
    });
    expect(tools.execute).not.toHaveBeenCalled();
  });
});
