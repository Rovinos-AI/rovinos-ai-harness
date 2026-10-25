// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Code, Id, ToolSpecSchema } from "@rovinos/schemas";
import type { ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  APP_TELEMETRY_TOOL,
  APP_TELEMETRY_TOOL_NAME,
  AppCallRouter,
  AppCallRouterError,
} from "./app-calls.js";
import type { AppCall, AppInstance } from "./types.js";

const runId = Id.parse("00000000000000000000000001");
const foreignRunId = Id.parse("00000000000000000000000002");
const callId = Id.parse("00000000000000000000000003");
const approvalId = Id.parse("00000000000000000000000004");
const app = {
  id: Code.parse("approval"),
  resourceUri: "ui://approval/index.html",
  telemetry: true,
  allowedTools: [Code.parse("approval.resolve"), Code.parse("notes.write")],
  allow: { openLink: false, message: false, modelContext: false },
};
const session: AppInstance = {
  id: app.id,
  resourceUri: app.resourceUri,
  sessionId: Id.parse("00000000000000000000000005"),
  sessionStartTime: 0,
  runId,
  end: () => undefined,
};

function request(values: Partial<AppCall> & Pick<AppCall, "toolName" | "arguments">): AppCall {
  return {
    appId: app.id,
    sessionId: session.sessionId,
    ...values,
  };
}

function makeTool(name: string, metadata?: Tool["_meta"]): Tool {
  return {
    name,
    description: "Allowed app tool",
    inputSchema: { type: "object" },
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}

describe("AppCallRouter", () => {
  it("handles app-originated telemetry locally and never forwards it to MCP tools", async () => {
    const onAppCall = vi.fn(() => Promise.resolve({ content: [] }));
    const onTelemetryEmit = vi.fn(() => Promise.resolve({ content: [] }));
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppCall,
      onTelemetryEmit,
    });

    await expect(
      router.handle(
        session,
        request({
          toolName: APP_TELEMETRY_TOOL_NAME,
          arguments: { spans: [{ name: "ui.render" }] },
        }),
      ),
    ).resolves.toEqual({ content: [] });

    expect(onTelemetryEmit).toHaveBeenCalledWith(
      session,
      { spans: [{ name: "ui.render" }] },
      { runId, policyContext: { subagent: false, app: app.id } },
    );
    expect(onTelemetryEmit).toHaveBeenCalledTimes(1);
    expect(onAppCall).not.toHaveBeenCalled();
  });

  it("forwards allowlisted calls under the session run and app policy context", async () => {
    const onAppCall = vi.fn(() => Promise.resolve({ content: [] }));
    const isIdOwnedByRun = vi.fn(() => true);
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppCall,
      isIdOwnedByRun,
    });

    await router.handle(
      session,
      request({
        toolName: "approval.resolve",
        arguments: {},
        callId,
        approvalId,
        approvalIds: [approvalId],
      }),
    );

    expect(onAppCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "approval.resolve" }),
      { runId, policyContext: { subagent: false, app: app.id } },
    );
    expect(isIdOwnedByRun).toHaveBeenCalledTimes(3);
    expect(isIdOwnedByRun).toHaveBeenCalledWith(runId, callId);
  });

  it("rejects and counts non-allowlisted calls", async () => {
    const onRejected = vi.fn();
    const onAppCall = vi.fn(() => Promise.resolve({ content: [] }));
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppCall,
      onRejected,
    });

    await expect(
      router.handle(session, request({ toolName: "filesystem.write", arguments: {} })),
    ).rejects.toMatchObject({ code: "app_tool_not_allowed" });

    expect(onRejected).toHaveBeenCalledWith("unknown_tool");
    expect(onAppCall).not.toHaveBeenCalled();
  });

  it("rejects telemetry for apps that have not opted in", async () => {
    const onTelemetryEmit = vi.fn(() => Promise.resolve({ content: [] }));
    const onRejected = vi.fn();
    const router = new AppCallRouter({
      apps: new Map([[app.id, { ...app, telemetry: false }]]),
      onTelemetryEmit,
      onRejected,
    });

    await expect(
      router.handle(
        session,
        request({
          toolName: APP_TELEMETRY_TOOL_NAME,
          arguments: { spans: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: "app_tool_not_allowed" });

    expect(onTelemetryEmit).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith("unknown_tool");
  });

  it("rejects cross-run request and approval identifiers before forwarding", async () => {
    const onAppCall = vi.fn(() => Promise.resolve({ content: [] }));
    const isIdOwnedByRun = vi.fn((_owner: Id, id: Id) => id !== approvalId);
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppCall,
      isIdOwnedByRun,
    });

    await expect(
      router.handle(
        session,
        request({ toolName: "approval.resolve", arguments: {}, runId: foreignRunId }),
      ),
    ).rejects.toMatchObject({ code: "app_run_mismatch" });
    await expect(
      router.handle(session, request({ toolName: "approval.resolve", arguments: {}, approvalId })),
    ).rejects.toBeInstanceOf(AppCallRouterError);

    expect(onAppCall).not.toHaveBeenCalled();
  });

  it("validates run and approval identifiers carried in bridge tool arguments", async () => {
    const onAppCall = vi.fn(() => Promise.resolve({ content: [] }));
    const isIdOwnedByRun = vi.fn((_owner: Id, id: Id) => id !== approvalId);
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppCall,
      isIdOwnedByRun,
    });

    await expect(
      router.handle(
        session,
        request({
          toolName: "approval.resolve",
          arguments: { runId: foreignRunId },
        }),
      ),
    ).rejects.toMatchObject({ code: "app_run_mismatch" });
    await expect(
      router.handle(
        session,
        request({
          toolName: "approval.resolve",
          arguments: { approvalId },
        }),
      ),
    ).rejects.toMatchObject({ code: "app_run_mismatch" });

    expect(isIdOwnedByRun).toHaveBeenCalledWith(runId, approvalId);
    expect(onAppCall).not.toHaveBeenCalled();
  });

  it("rejects opted-in telemetry when the local handler is unavailable", async () => {
    const onRejected = vi.fn();
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onRejected,
    });

    await expect(
      router.handle(
        session,
        request({ toolName: APP_TELEMETRY_TOOL_NAME, arguments: { spans: [] } }),
      ),
    ).rejects.toMatchObject({ code: "app_telemetry_unavailable" });

    expect(onRejected).toHaveBeenCalledWith("telemetry_unavailable");
  });

  it("fails closed when scoped ids cannot be verified or the session has no run", async () => {
    const router = new AppCallRouter({ apps: new Map([[app.id, app]]) });
    await expect(
      router.handle(session, request({ toolName: "approval.resolve", arguments: {}, callId })),
    ).rejects.toMatchObject({ code: "app_run_mismatch" });
    await expect(
      router.handle(
        {
          id: session.id,
          resourceUri: session.resourceUri,
          sessionId: session.sessionId,
          sessionStartTime: 0,
          end: session.end,
        },
        request({ toolName: APP_TELEMETRY_TOOL_NAME, arguments: { spans: [] } }),
      ),
    ).rejects.toMatchObject({ code: "app_run_unavailable" });
  });

  it("returns no tools when the app has no allowlist and filters discovery to allowed tools", async () => {
    const onAppToolsList = vi.fn(
      (_id: Code, _allowed: readonly Code[], _cursor?: string): Promise<ListToolsResult> =>
        Promise.resolve({
          tools: [
            makeTool("approval.resolve"),
            makeTool("notes.write", { ui: { visibility: ["app"] } }),
            makeTool("filesystem.write"),
            makeTool("model.only", { ui: { visibility: ["model"] } }),
            makeTool(APP_TELEMETRY_TOOL_NAME),
          ],
          nextCursor: "next-page",
        }),
    );
    const emptyAllowlistRouter = new AppCallRouter({
      apps: new Map([[app.id, { ...app, allowedTools: [] }]]),
      onAppToolsList,
    });
    const router = new AppCallRouter({
      apps: new Map([[app.id, app]]),
      onAppToolsList,
    });

    await expect(emptyAllowlistRouter.listTools(session)).resolves.toEqual({ tools: [] });
    expect(onAppToolsList).not.toHaveBeenCalled();
    await expect(router.listTools(session, "cursor")).resolves.toEqual({
      tools: [
        makeTool("approval.resolve"),
        makeTool("notes.write", { ui: { visibility: ["app"] } }),
      ],
      nextCursor: "next-page",
    });
    expect(onAppToolsList).toHaveBeenCalledWith(app.id, app.allowedTools, "cursor");
    const firstPage = await router.listTools(session);
    expect(firstPage.tools.map(({ name }) => name)).toEqual([
      "approval.resolve",
      "notes.write",
      APP_TELEMETRY_TOOL_NAME,
    ]);
    expect(firstPage.tools[2]?._meta).toEqual({ ui: { visibility: ["app"] } });
  });

  it("declares telemetry as app-only without making it a model ToolSpec", () => {
    expect(isToolVisibilityAppOnly(APP_TELEMETRY_TOOL)).toBe(true);
    expect(APP_TELEMETRY_TOOL._meta).toEqual({ ui: { visibility: ["app"] } });
    expect(ToolSpecSchema.safeParse(APP_TELEMETRY_TOOL).success).toBe(false);
  });
});
