// SPDX-License-Identifier: Apache-2.0
import type { Runtime } from "@harness/core";
import { HarnessConfigSchema } from "@harness/config";
import { createEventBuilders } from "@harness/store/testing";
import { Id, type NewEvent } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { createApprovalViewHost } from "./approval-view.js";

const hostMock = vi.hoisted(() => {
  let dependencies: unknown;
  const close = vi.fn(() => Promise.resolve());
  return {
    close,
    dependencies: () => dependencies,
    createReferenceHost: vi.fn((_config: unknown, received: unknown) => {
      dependencies = received;
      return Promise.resolve({ url: "http://127.0.0.1:3000/#token", close });
    }),
  };
});

vi.mock("@harness/host", () => ({
  createReferenceHost: hostMock.createReferenceHost,
}));

vi.mock("@harness/control-plane", () => ({
  APPROVAL_RESOURCE_URI: "ui://harness/approval/v1",
  MCP_APP_HTML_MIME_TYPE: "text/html;profile=mcp-app",
  loadApprovalHtml: () => "<html>approval</html>",
}));

const payload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000003",
  toolId: "test.tool",
  args: { email: "<EMAIL_1>" },
  ruleId: "test.rule",
  reason: "needs_review",
  summary: "Review tool call",
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review the request." },
  editableFields: [],
} as const;

async function createFixture(options: {
  readonly allowReveal?: boolean;
  readonly requireElicitation?: boolean;
  readonly isTTY?: boolean;
  readonly confirm?: () => Promise<boolean>;
} = {}) {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const approvalId = builders.nextRunId();
  const store = new InMemoryEventStore();
  const events: NewEvent[] = [
    builders.runCreated(runId),
    builders.runStatusChanged(runId, "pending", "running"),
    {
      runId,
      ts: 2,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "approval_requested",
      approvalId,
      callId: builders.nextRunId(),
      payload,
    },
    builders.runStatusChanged(runId, "running", "suspended"),
  ];
  await store.append(runId, events, 0);
  const resolveApproval = vi.fn(() => Promise.resolve());
  const resolveMany = vi.fn(() => Promise.resolve(["alice@example.test"]));
  const runtime = {
    store,
    resolveApproval,
    hasPendingApproval: () => Promise.resolve(true),
    tokenizeAppContent: (_id: Id, content: unknown) => Promise.resolve(content),
    onAppContent: vi.fn(() => Promise.resolve()),
    vault: { resolveMany },
  } as unknown as Runtime;
  let now = 1_000;
  const context = {
    clock: { now: () => now },
    out: { error: vi.fn() },
    interactive:
      options.isTTY === true
        ? { isTTY: true, confirm: options.confirm ?? (() => Promise.resolve(true)) }
        : undefined,
  } as unknown as CliContext;
  const config = HarnessConfigSchema.parse({
    controlPlane:
      options.allowReveal === true
        ? {
            allowReveal: true,
            reveal: { requireElicitation: options.requireElicitation ?? true },
          }
        : undefined,
  });
  const host = await createApprovalViewHost(runtime, context, config, runId, approvalId);
  const dependencies = hostMock.dependencies() as {
    readonly readResource: (uri: string) => Promise<unknown>;
    readonly onAppToolsList: () => Promise<{ readonly tools: readonly { readonly name: string }[] }>;
    readonly onAppCall: (
      call: { readonly sessionId: string; readonly toolName: string; readonly arguments: Record<string, unknown> },
      callContext: { readonly runId: Id },
    ) => Promise<{ readonly structuredContent?: unknown; readonly isError?: boolean }>;
    readonly hasPendingApproval: (id: Id) => Promise<boolean>;
    readonly tokenizeAppContent: (id: Id, content: never, context: { readonly boundary: "model_input" }) => Promise<unknown>;
    readonly onAppContent: (content: never) => Promise<void>;
  };
  return {
    approvalId,
    runId,
    now: (value: number) => {
      now = value;
    },
    context,
    dependencies,
    host,
    resolveApproval,
    resolveMany,
    store,
    runtime,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("approval reference host", () => {
  it("serves the built resource, exposes app-only tools, and forwards runtime callbacks", async () => {
    const fixture = await createFixture();
    const resource = (await fixture.dependencies.readResource("ui://harness/approval/v1")) as {
      readonly contents: readonly { readonly mimeType: string; readonly text: string }[];
    };

    expect(fixture.host.url).toContain("127.0.0.1");
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      text: "<html>approval</html>",
    });
    expect((await fixture.dependencies.onAppToolsList()).tools.map((tool) => tool.name)).toEqual([
      "harness.approvals.resolve",
      "harness.approvals.reveal",
    ]);
    await expect(fixture.dependencies.hasPendingApproval(fixture.runId)).resolves.toBe(true);
    await expect(
      fixture.dependencies.tokenizeAppContent(
        fixture.runId,
        { text: "app" } as never,
        { boundary: "model_input" },
      ),
    ).resolves.toEqual({ text: "app" });
    await fixture.dependencies.onAppContent({} as never);
    expect(fixture.runtime.onAppContent).toHaveBeenCalledOnce();
    await fixture.host.close();
  });

  it("resolves only the selected pending approval and rejects foreign calls", async () => {
    const fixture = await createFixture();
    const callContext = { runId: fixture.runId };
    const denied = await fixture.dependencies.onAppCall(
      {
        sessionId: "00000000000000000000000004",
        toolName: "harness.approvals.resolve",
        arguments: { approvalId: "99999999999999999999999999", decision: "approve" },
      },
      callContext,
    );
    expect(denied.isError).toBe(true);
    const succeeded = await fixture.dependencies.onAppCall(
      {
        sessionId: "00000000000000000000000004",
        toolName: "harness.approvals.resolve",
        arguments: { approvalId: fixture.approvalId, decision: "approve" },
      },
      callContext,
    );
    expect(succeeded.structuredContent).toEqual({ ok: true });
    expect(fixture.resolveApproval).toHaveBeenCalledWith(
      fixture.runId,
      fixture.approvalId,
      "approve",
      { metadata: { decidedBy: "human" } },
    );
    const foreign = await fixture.dependencies.onAppCall(
      {
        sessionId: "00000000000000000000000004",
        toolName: "harness.approvals.resolve",
        arguments: { approvalId: fixture.approvalId, decision: "approve" },
      },
      { runId: Id.parse("99999999999999999999999999") },
    );
    expect(foreign.isError).toBe(true);
    await fixture.store.close();
  });

  it("keeps reveal disabled by default and confirms, validates, and limits enabled reveals", async () => {
    const disabled = await createFixture();
    const request = {
      approvalId: disabled.approvalId,
      pointers: ["/email"],
    };
    const denied = await disabled.dependencies.onAppCall(
      {
        sessionId: "session",
        toolName: "harness.approvals.reveal",
        arguments: request,
      },
      { runId: disabled.runId },
    );
    expect(denied.isError).toBe(true);
    expect(disabled.resolveMany).not.toHaveBeenCalled();
    await disabled.store.close();

    const enabled = await createFixture({ allowReveal: true, isTTY: true });
    const call = (pointer: string) =>
      enabled.dependencies.onAppCall(
        {
          sessionId: "session",
          toolName: "harness.approvals.reveal",
          arguments: { approvalId: enabled.approvalId, pointers: [pointer] },
        },
        { runId: enabled.runId },
      );
    expect((await call("/missing")).isError).toBe(true);
    enabled.now(61_001);
    let revealed: unknown;
    for (let index = 0; index < 5; index += 1) {
      const result = await call("/email");
      expect(result.isError).toBeUndefined();
      revealed ??= result.structuredContent;
      enabled.now(61_002 + index);
    }
    expect(revealed).toEqual({
      values: [{ pointer: "/email", value: "alice@example.test" }],
    });
    expect((await call("/email")).isError).toBe(true);
    await enabled.store.close();
  });

  it("requires elicitation confirmation when configured and catches unexpected tools", async () => {
    const noTty = await createFixture({ allowReveal: true });
    const call = {
      sessionId: "session",
      toolName: "harness.approvals.reveal",
      arguments: { approvalId: noTty.approvalId, pointers: ["/email"] },
    };
    expect(
      (
        await noTty.dependencies.onAppCall(call, {
          runId: noTty.runId,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await noTty.dependencies.onAppCall(
          { ...call, toolName: "unexpected.tool" },
          { runId: noTty.runId },
        )
      ).isError,
    ).toBe(true);
    await noTty.store.close();
  });
});
