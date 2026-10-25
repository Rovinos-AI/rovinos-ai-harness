// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import type { ModelToolCall, PolicyPort, RunContext, ToolPort } from "@rovinos/core";
import { PolicyEngine } from "@rovinos/policy";
import { createPolicyCheckedAppCallHandler, type AppCall } from "@rovinos/host";
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

  it("fails closed when the host cannot suspend an ask decision", async () => {
    const tools = tool();
    const result = await handler(policy("ask"), tools.port)(call, context);

    expect(result).toEqual({
      content: [{ type: "text", text: "app_call_requires_approval" }],
      isError: true,
    });
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("delegates ask to the configured approval handler and returns its result to the app", async () => {
    const tools = tool();
    const onAppCallApproval = vi.fn(() =>
      Promise.resolve({ content: [{ type: "text" as const, text: '{"completed":true}' }] }),
    );
    const result = await createPolicyCheckedAppCallHandler({
      policy: policy("ask"),
      tool: tools.port,
      nextCallId: () => Id.parse("00000000000000000000000003"),
      onAppCallApproval,
    })(call, context);

    expect(result).toEqual({ content: [{ type: "text", text: '{"completed":true}' }] });
    expect(onAppCallApproval).toHaveBeenCalledWith(
      {
        callId: Id.parse("00000000000000000000000003"),
        toolId: Code.parse("approve"),
        args: { value: "<PATH_1>" },
      },
      expect.objectContaining({
        decision: "ask",
        ruleId: Code.parse("app_rule"),
        reason: Code.parse("app_rule_reason"),
        editable: [],
      }),
      context,
    );
    expect(JSON.stringify(onAppCallApproval.mock.calls)).not.toContain("synthetic raw input");
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("fails closed without preparation before delegating an ask with raw arguments", async () => {
    const tools = tool();
    const onAppCallApproval = vi.fn(() => Promise.resolve({ content: [] }));
    const result = await createPolicyCheckedAppCallHandler({
      policy: policy("ask"),
      tool: {
        describe: (toolId, args) => tools.port.describe(toolId, args),
        execute: tools.execute,
      },
      nextCallId: () => Id.parse("00000000000000000000000003"),
      onAppCallApproval,
    })(call, context);

    expect(result).toEqual({
      content: [{ type: "text", text: "app_call_requires_approval" }],
      isError: true,
    });
    expect(onAppCallApproval).not.toHaveBeenCalled();
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["denied", { content: [{ type: "text" as const, text: "approval_denied" }], isError: true }],
    ["expired", { content: [{ type: "text" as const, text: "approval_expired" }], isError: true }],
  ])("delivers a typed %s result returned by approval/resume", async (_outcome, response) => {
    const tools = tool();
    const onAppCallApproval = vi.fn(() => Promise.resolve(response));
    const result = await createPolicyCheckedAppCallHandler({
      policy: policy("ask"),
      tool: tools.port,
      nextCallId: () => Id.parse("00000000000000000000000003"),
      onAppCallApproval,
    })(call, context);

    expect(result).toEqual(response);
    expect(onAppCallApproval).toHaveBeenCalledOnce();
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
