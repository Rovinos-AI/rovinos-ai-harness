// SPDX-License-Identifier: Apache-2.0
import type { ReferenceHostDependencies } from "@harness/host";
import { HarnessConfigSchema } from "@harness/config";
import { createEventBuilders } from "@harness/store/testing";
import {
  AppContentEnvelopeSchema,
  Code,
  HarnessError,
  Id,
  type JsonValue,
  type NewEvent,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@harness/host", () => ({
  createReferenceHost: hostMock.createReferenceHost,
}));

const approvalHtmlMock = vi.hoisted(() => vi.fn(() => "<html>approval</html>"));

class MissingApprovalHtmlError extends HarnessError {
  override readonly code = "approval_resource_unavailable";

  constructor() {
    super("The approval app resource is unavailable.");
  }
}

vi.mock("@harness/control-plane", () => ({
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
  },
  ruleId: "test.rule",
  reason: "needs_review",
  summary: "Review tool call",
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review the request." },
  editableFields: [],
};

type ApprovalViewInput = Parameters<typeof createApprovalViewHost>[0];
type ApprovalViewDependencies = ReferenceHostDependencies & {
  readonly onAppToolsList: NonNullable<ReferenceHostDependencies["onAppToolsList"]>;
  readonly onAppCall: NonNullable<ReferenceHostDependencies["onAppCall"]>;
  readonly hasPendingApproval: NonNullable<ReferenceHostDependencies["hasPendingApproval"]>;
  readonly tokenizeAppContent: NonNullable<ReferenceHostDependencies["tokenizeAppContent"]>;
  readonly onAppContent: NonNullable<ReferenceHostDependencies["onAppContent"]>;
};

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

async function createFixture(options: {
  readonly allowReveal?: boolean;
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
  const resolveApproval = vi.fn(
    (..._args: Parameters<ApprovalViewInput["runtime"]["resolveApproval"]>) =>
      Promise.resolve(undefined),
  );
  const resolveMany = vi.fn(
    (...args: Parameters<ApprovalViewInput["runtime"]["vault"]["resolveMany"]>) => {
      expect(args[2]).toMatchObject({ boundary: "ui" });
      return Promise.resolve(
        args[1].map((token) =>
          token === "<PHONE_2>" ? "555-0101" : "alice@example.test",
        ),
      );
    },
  );
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
    vault: { resolveMany },
  } satisfies ApprovalViewInput["runtime"];
  let now = 1_000;
  const context = {
    clock: { now: () => now },
    out: { error: vi.fn() },
    interactive:
      options.isTTY === true
        ? { isTTY: true, confirm: options.confirm ?? (() => Promise.resolve(true)) }
        : undefined,
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
    const tools = await fixture.dependencies.onAppToolsList(
      Code.parse("harness.approval"),
      [Code.parse("harness.approvals.resolve"), Code.parse("harness.approvals.reveal")],
    );
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "harness.approvals.resolve",
      "harness.approvals.reveal",
    ]);
    await expect(fixture.dependencies.hasPendingApproval(fixture.runId)).resolves.toBe(true);
    await expect(
      fixture.dependencies.tokenizeAppContent(
        fixture.runId,
        { text: "app" },
        "model_input",
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
    const call = (pointer: string | readonly string[]) =>
      enabled.dependencies.onAppCall(
        {
          sessionId: "session",
          toolName: "harness.approvals.reveal",
          arguments: {
            approvalId: enabled.approvalId,
            pointers: typeof pointer === "string" ? [pointer] : pointer,
          },
        },
        { runId: enabled.runId },
      );
    expect((await call("/tooMany")).isError).toBe(true);
    expect((await call("/missing")).isError).toBe(true);
    enabled.now(61_001);
    let revealed: unknown;
    for (let index = 0; index < 5; index += 1) {
      const result = await call(
        index === 0 ? ["/email", "/multiple"] : "/email",
      );
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
});
