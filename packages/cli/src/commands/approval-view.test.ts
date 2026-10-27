// SPDX-License-Identifier: Apache-2.0
import type { AppCallExecutionContext, ReferenceHostDependencies } from "@rovinos/host";
import { HarnessConfigSchema } from "@rovinos/config";
import { createEventBuilders } from "@rovinos/store/testing";
import {
  AppContentEnvelopeSchema,
  Code,
  HarnessError,
  Id,
  type JsonValue,
  type NewEvent,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { AuditingVaultResolver } from "@rovinos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutput } from "../output.js";
import { createApprovalViewHost } from "./approval-view.js";

const hostMock = vi.hoisted(() => {
  let dependencies: ReferenceHostDependencies | undefined;
  const close = vi.fn(() => Promise.resolve());
  return {
    close,
    dependencies: () => dependencies,
    createReferenceHost: vi.fn((_config: unknown, received: ReferenceHostDependencies) => {
      dependencies = received;
      return Promise.resolve({ url: "http://127.0.0.1:3000/#token", close });
    }),
  };
});

vi.mock("@rovinos/host", () => ({
  createReferenceHost: hostMock.createReferenceHost,
}));

const approvalHtmlMock = vi.hoisted(() => vi.fn(() => "<html>approval</html>"));

class MissingApprovalHtmlError extends HarnessError {
  override readonly code = "approval_resource_unavailable";

  constructor() {
    super("The approval app resource is unavailable.");
  }
}

vi.mock("@rovinos/control-plane", () => ({
  APPROVAL_RESOURCE_URI: "ui://harness/approval/v1",
  MCP_APP_HTML_MIME_TYPE: "text/html;profile=mcp-app",
  loadApprovalHtml: approvalHtmlMock,
}));

const payload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000003",
  toolId: "test.tool",
  args: {
    email: "Contact <EMAIL_1>",
    multiple: "<EMAIL_1> / <PHONE_2>",
    tooMany: Array.from({ length: 21 }, () => "<EMAIL_1>").join(" "),
    items: ["<EMAIL_1>"],
    "escaped/key": "<PHONE_2>",
    editable: "original",
  },
  ruleId: "test.rule",
  reason: "needs_review",
  summary: "Review tool call",
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review the request." },
  editableFields: ["/editable"],
};

type ApprovalViewInput = Parameters<typeof createApprovalViewHost>[0];
type ApprovalViewDependencies = ReferenceHostDependencies & {
  readonly onAppToolsList: NonNullable<ReferenceHostDependencies["onAppToolsList"]>;
  readonly onAppCall: NonNullable<ReferenceHostDependencies["onAppCall"]>;
  readonly hasPendingApproval: NonNullable<ReferenceHostDependencies["hasPendingApproval"]>;
  readonly tokenizeAppContent: NonNullable<ReferenceHostDependencies["tokenizeAppContent"]>;
  readonly onAppContent: NonNullable<ReferenceHostDependencies["onAppContent"]>;
};

function appCallContext(runId: Id): AppCallExecutionContext {
  return { runId, policyContext: { subagent: false, app: Code.parse("harness.approval") } };
}

function getApprovalViewDependencies(): ApprovalViewDependencies {
  const dependencies = hostMock.dependencies();
  if (
    dependencies?.onAppToolsList === undefined ||
    dependencies.onAppCall === undefined ||
    dependencies.hasPendingApproval === undefined ||
    dependencies.tokenizeAppContent === undefined ||
    dependencies.onAppContent === undefined
  ) {
    throw new Error("Approval view host dependencies were not captured.");
  }
  return {
    ...dependencies,
    onAppToolsList: dependencies.onAppToolsList,
    onAppCall: dependencies.onAppCall,
    hasPendingApproval: dependencies.hasPendingApproval,
    tokenizeAppContent: dependencies.tokenizeAppContent,
    onAppContent: dependencies.onAppContent,
  };
}

async function createFixture(
  options: {
    readonly allowReveal?: boolean;
    readonly isTTY?: boolean;
    readonly confirm?: () => Promise<boolean>;
  } = {},
) {
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
  const resolveApproval = vi.fn(
    (..._args: Parameters<ApprovalViewInput["runtime"]["resolveApproval"]>) =>
      Promise.resolve(undefined),
  );
  const vault = new AuditingVaultResolver(
    {
      resolve: (_id, token, resolveContext) => {
        expect(resolveContext).toMatchObject({ boundary: "ui" });
        return Promise.resolve(token === "<PHONE_2>" ? "555-0101" : "alice@example.test");
      },
    },
    () => undefined,
  );
  const resolveMany = vi.spyOn(vault, "resolveMany");
  const onAppContent = vi.fn();
  const runtime = {
    store,
    resolveApproval,
    hasPendingApproval: () => Promise.resolve(true),
    tokenizeAppContent: (_id: Id, content: JsonValue) => Promise.resolve(content),
    onAppContent: () => {
      onAppContent();
      return Promise.resolve();
    },
    vault,
  } satisfies ApprovalViewInput["runtime"];
  let now = 1_000;
  const context = {
    clock: { now: () => now },
    out: createOutput({ stdout: vi.fn(), stderr: vi.fn() }),
    ...(options.isTTY === true
      ? {
          interactive: {
            isTTY: true,
            confirm: options.confirm ?? (() => Promise.resolve(true)),
          },
        }
      : {}),
  } satisfies ApprovalViewInput["context"];
  const config = HarnessConfigSchema.parse({
    controlPlane: options.allowReveal === true ? { allowReveal: true } : undefined,
  });
  const host = await createApprovalViewHost({ runtime, context, config, runId, approvalId });
  const dependencies = getApprovalViewDependencies();
  return {
    approvalId,
    runId,
    now: (value: number) => {
      now = value;
    },
    context,
    dependencies,
    host,
    onAppContent,
    resolveApproval,
    resolveMany,
    store,
    runtime,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  approvalHtmlMock.mockImplementation(() => "<html>approval</html>");
});

describe("approval reference host", () => {
  it("serves the built resource, exposes app-only tools, and forwards runtime callbacks", async () => {
    const fixture = await createFixture();
    const resource = await fixture.dependencies.readResource("ui://harness/approval/v1");

    expect(fixture.host.url).toContain("127.0.0.1");
    expect(resource).toMatchObject({
      contents: [
        {
          mimeType: "text/html;profile=mcp-app",
          text: "<html>approval</html>",
        },
      ],
    });
    await fixture.dependencies.readResource("ui://harness/approval/v1");
    expect(approvalHtmlMock).toHaveBeenCalledOnce();
    expect(hostMock.dependencies()).toMatchObject({
      uiSessionContext: { runId: fixture.runId },
    });
    const uiSessionContext = fixture.dependencies.uiSessionContext;
    if (uiSessionContext === undefined) {
      throw new Error("Approval view UI session context was not configured.");
    }
    expect(uiSessionContext.toolCallSpanContext).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    });
    const tools = await fixture.dependencies.onAppToolsList(Code.parse("harness.approval"), [
      Code.parse("harness.approvals.resolve"),
      Code.parse("harness.approvals.reveal"),
    ]);
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "harness.approvals.resolve",
      "harness.approvals.reveal",
    ]);
    await expect(fixture.dependencies.hasPendingApproval(fixture.runId)).resolves.toBe(true);
    await expect(
      fixture.dependencies.tokenizeAppContent(
        fixture.runId,
        { text: "app" },
        { boundary: "model_input" },
      ),
    ).resolves.toEqual({ text: "app" });
    await fixture.dependencies.onAppContent(
      AppContentEnvelopeSchema.parse({
        kind: "message",
        source: "app",
        label: "App-provided",
        appId: "harness.approval",
        runId: fixture.runId,
        content: { text: "app" },
      }),
    );
    expect(fixture.onAppContent.mock.calls).toHaveLength(1);
    await fixture.host.close();
  });

  it("resolves only the selected pending approval and rejects foreign calls", async () => {
    const fixture = await createFixture();
    const callContext = appCallContext(fixture.runId);
    const denied = await fixture.dependencies.onAppCall(
      {
        appId: Code.parse("harness.approval"),
        sessionId: Id.parse("00000000000000000000000004"),
        toolName: "harness.approvals.resolve",
        arguments: { approvalId: "99999999999999999999999999", decision: "approve" },
      },
      callContext,
    );
    expect(denied.isError).toBe(true);
    const succeeded = await fixture.dependencies.onAppCall(
      {
        appId: Code.parse("harness.approval"),
        sessionId: Id.parse("00000000000000000000000004"),
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
      { metadata: { decidedBy: "human", approverId: "cli.local" } },
    );
    const foreign = await fixture.dependencies.onAppCall(
      {
        appId: Code.parse("harness.approval"),
        sessionId: Id.parse("00000000000000000000000004"),
        toolName: "harness.approvals.resolve",
        arguments: { approvalId: fixture.approvalId, decision: "approve" },
      },
      appCallContext(Id.parse("99999999999999999999999999")),
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
        appId: Code.parse("harness.approval"),
        sessionId: Id.parse("00000000000000000000000004"),
        toolName: "harness.approvals.reveal",
        arguments: request,
      },
      appCallContext(disabled.runId),
    );
    expect(denied.isError).toBe(true);
    expect(disabled.resolveMany).not.toHaveBeenCalled();
    await disabled.store.close();

    const enabled = await createFixture({ allowReveal: true, isTTY: true });
    const call = (pointer: string | readonly string[]) =>
      enabled.dependencies.onAppCall(
        {
          appId: Code.parse("harness.approval"),
          sessionId: Id.parse("00000000000000000000000004"),
          toolName: "harness.approvals.reveal",
          arguments: {
            approvalId: enabled.approvalId,
            pointers: typeof pointer === "string" ? [pointer] : pointer,
          },
        },
        appCallContext(enabled.runId),
      );
    expect((await call("/tooMany")).isError).toBe(true);
    expect((await call("/missing")).isError).toBe(true);
    enabled.now(61_001);
    let revealed: unknown;
    for (let index = 0; index < 5; index += 1) {
      const result = await call(index === 0 ? ["/email", "/multiple"] : "/email");
      expect(result.isError).toBeUndefined();
      revealed ??= result.structuredContent;
      enabled.now(61_002 + index);
    }
    expect(revealed).toEqual({
      values: [
        { pointer: "/email", value: "Contact alice@example.test" },
        { pointer: "/multiple", value: "alice@example.test / 555-0101" },
      ],
    });
    expect((await call("/email")).isError).toBe(true);
    await enabled.store.close();
  });

  it("requires elicitation confirmation when configured and catches unexpected tools", async () => {
    const noTty = await createFixture({ allowReveal: true });
    const call = {
      appId: Code.parse("harness.approval"),
      sessionId: Id.parse("00000000000000000000000004"),
      toolName: "harness.approvals.reveal",
      arguments: { approvalId: noTty.approvalId, pointers: ["/email"] },
    };
    expect((await noTty.dependencies.onAppCall(call, appCallContext(noTty.runId))).isError).toBe(
      true,
    );
    expect(
      (
        await noTty.dependencies.onAppCall(
          { ...call, toolName: "unexpected.tool" },
          appCallContext(noTty.runId),
        )
      ).isError,
    ).toBe(true);
    await noTty.store.close();
  });

  it("fails before starting the host when the approval HTML artifact is unavailable", async () => {
    const fixture = await createFixture();
    hostMock.createReferenceHost.mockClear();
    approvalHtmlMock.mockImplementationOnce(() => {
      throw new MissingApprovalHtmlError();
    });

    await expect(
      createApprovalViewHost({
        runtime: fixture.runtime,
        context: fixture.context,
        config: HarnessConfigSchema.parse({}),
        runId: fixture.runId,
        approvalId: fixture.approvalId,
      }),
    ).rejects.toMatchObject({ code: "approval_resource_unavailable" });
    expect(hostMock.createReferenceHost).not.toHaveBeenCalled();
    await fixture.store.close();
  });

  it("reports invalid edits and preserves only valid error codes from approval failures", async () => {
    const fixture = await createFixture();
    const call = (argumentsValue: Record<string, unknown>) =>
      fixture.dependencies.onAppCall(
        {
          appId: Code.parse("harness.approval"),
          sessionId: Id.parse("00000000000000000000000004"),
          toolName: "harness.approvals.resolve",
          arguments: argumentsValue,
        },
        appCallContext(fixture.runId),
      );

    expect(
      (
        await call({
          approvalId: fixture.approvalId,
          decision: "edit",
          edits: [{ pointer: "/email", value: "updated" }],
        })
      ).structuredContent,
    ).toMatchObject({ ok: false, code: "edit_not_allowed" });
    fixture.resolveApproval.mockRejectedValueOnce({ code: "approval_not_found" });
    expect(
      (
        await call({
          approvalId: fixture.approvalId,
          decision: "approve",
        })
      ).structuredContent,
    ).toMatchObject({ ok: false, code: "approval_not_found" });
    fixture.resolveApproval.mockRejectedValueOnce({ code: "not a code" });
    expect(
      (
        await call({
          approvalId: fixture.approvalId,
          decision: "approve",
        })
      ).structuredContent,
    ).toMatchObject({ ok: false, code: "approval_operation_failed" });
    expect(
      (
        await call({
          approvalId: fixture.approvalId,
          decision: "edit",
          edits: [{ pointer: "/editable", value: "updated" }],
        })
      ).structuredContent,
    ).toEqual({ ok: true });
    expect(fixture.resolveApproval).toHaveBeenLastCalledWith(
      fixture.runId,
      fixture.approvalId,
      "edit",
      expect.objectContaining({ edits: { ...payload.args, editable: "updated" } }),
    );
    await fixture.store.close();
  });

  it("resolves array and escaped object pointers while rejecting invalid selections", async () => {
    const fixture = await createFixture({ allowReveal: true, isTTY: true });
    let sessionIndex = 10;
    const call = (pointer: string) => {
      sessionIndex += 1;
      return fixture.dependencies.onAppCall(
        {
          appId: Code.parse("harness.approval"),
          sessionId: Id.parse(String(sessionIndex).padStart(26, "0")),
          toolName: "harness.approvals.reveal",
          arguments: { approvalId: fixture.approvalId, pointers: [pointer] },
        },
        appCallContext(fixture.runId),
      );
    };

    fixture.resolveMany.mockResolvedValueOnce([undefined]);
    expect((await call("/email")).content).toEqual([
      { type: "text", text: "reveal_value_unavailable" },
    ]);
    expect((await call("/items/0")).structuredContent).toEqual({
      values: [{ pointer: "/items/0", value: "alice@example.test" }],
    });
    expect((await call("/escaped~1key")).structuredContent).toEqual({
      values: [{ pointer: "/escaped~1key", value: "555-0101" }],
    });
    expect((await call("/items/01")).content).toEqual([
      { type: "text", text: "pointer_invalid" },
    ]);
    expect((await call("/items/999999999999999999999999")).content).toEqual([
      { type: "text", text: "pointer_invalid" },
    ]);
    expect((await call("")).content).toEqual([{ type: "text", text: "pointer_invalid" }]);
    await fixture.store.close();
  });

  it("rejects hosts for an empty run log or a different pending approval", async () => {
    const fixture = await createFixture();
    await expect(
      createApprovalViewHost({
        runtime: fixture.runtime,
        context: fixture.context,
        config: HarnessConfigSchema.parse({}),
        runId: fixture.runId,
        approvalId: Id.parse("00000000000000000000000005"),
      }),
    ).rejects.toMatchObject({ code: "approval_not_found" });
    vi.spyOn(fixture.store, "read").mockImplementation(async function* () {
      await Promise.resolve();
      return;
    });
    await expect(
      createApprovalViewHost({
        runtime: fixture.runtime,
        context: fixture.context,
        config: HarnessConfigSchema.parse({}),
        runId: fixture.runId,
        approvalId: fixture.approvalId,
      }),
    ).rejects.toMatchObject({ code: "approval_not_found" });
    await fixture.host.close();
    await fixture.store.close();
  });
});
