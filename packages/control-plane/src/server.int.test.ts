// SPDX-License-Identifier: Apache-2.0
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Code, ControlPlaneConfigSchema, Id, type NewEvent } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { AuditingVaultResolver, Token } from "@harness/vault";
import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RUNS_RESOURCE_URI, RUN_RESOURCE_URI_TEMPLATE } from "./resources/runs.js";
import type { ControlPlaneServerOptions } from "./server.js";
import { startControlPlaneHttp } from "./server.js";

const HTTP_TOKEN = "CONTROL_PLANE_HTTP_TEST_TOKEN_LONG_ENOUGH";
const AUTHORIZATION = `${String.fromCharCode(66, 101, 97, 114, 101, 114)} ${HTTP_TOKEN}`;

function controlPlaneOptions(
  options: ControlPlaneServerOptions = {},
  scopes: readonly string[] = ["admin"],
  runIds?: readonly Id[],
): ControlPlaneServerOptions {
  return {
    controlPlane: ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.test",
            secret: "env:CONTROL_PLANE_TEST_TOKEN",
            scopes,
            ...(runIds === undefined ? {} : { runIds }),
          },
        ],
      },
    }),
    secretResolver: { resolve: () => Promise.resolve({ reveal: () => HTTP_TOKEN }) },
    ...options,
  };
}

function sendMcpPayload(
  endpoint: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      new URL(endpoint),
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
      },
      (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          resolve({ status: incoming.statusCode ?? 0, body: responseBody });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function sendMcpRequest(endpoint: string, headers: Record<string, string>): Promise<number> {
  return sendMcpPayload(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers,
  ).then(({ status }) => status);
}

function createHttpTransport(endpoint: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: AUTHORIZATION } },
  });
}

describe("control-plane HTTP transport", () => {
  it("rejects unauthenticated initialize, tools/list, and tools/call before MCP dispatch", async () => {
    const store = new InMemoryEventStore();
    const server = await startControlPlaneHttp(store, 0, controlPlaneOptions());
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "unauthenticated-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_runs", arguments: {} },
      },
    ];
    try {
      for (const payload of requests) {
        const response = await sendMcpPayload(server.endpoint, payload);
        expect(response.status).toBe(401);
        expect(response.body).toBe("");
      }
      const invalid = await sendMcpPayload(
        server.endpoint,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { authorization: `${String.fromCharCode(66, 101, 97, 114, 101, 114)} invalid` },
      );
      expect(invalid).toEqual({ status: 401, body: "" });
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("filters listed runs and rejects tools outside token scopes and runIds", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const allowedRunId = builders.nextRunId();
    const deniedRunId = builders.nextRunId();
    await store.append(
      allowedRunId,
      [
        builders.runCreated(allowedRunId),
        builders.runStatusChanged(allowedRunId, "pending", "running"),
      ],
      0,
    );
    await store.append(
      deniedRunId,
      [
        builders.runCreated(deniedRunId),
        builders.runStatusChanged(deniedRunId, "pending", "running"),
      ],
      0,
    );
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({}, ["read"], [allowedRunId]),
    );
    const client = new Client({ name: "control-plane-scope-test", version: "1.0.0" });
    try {
      await client.connect(createHttpTransport(server.endpoint));
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(["get_run", "list_runs"]);

      const listed = await client.callTool({ name: "list_runs", arguments: {} });
      expect(listed.structuredContent).toMatchObject({
        runs: [{ runId: allowedRunId }],
      });

      expect(JSON.stringify(listed)).not.toContain(deniedRunId);
      await expect(
        client.callTool({ name: "get_run", arguments: { runId: deniedRunId } }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "run_not_found" }],
      });
      await expect(
        client.callTool({ name: "resume_run", arguments: { runId: allowedRunId } }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "control_plane_scope_required" }],
      });
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("requires run scope for start_run and continue_run", async () => {
    const store = new InMemoryEventStore();
    const startRun = vi.fn(() =>
      Promise.resolve({
        runId: Id.parse("00000000000000000000000003"),
        status: "pending" as const,
      }),
    );
    const continueRun = vi.fn(() =>
      Promise.resolve({
        runId: Id.parse("00000000000000000000000004"),
        status: "pending" as const,
      }),
    );
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({ operations: { startRun, continueRun } }, ["read"]),
    );
    const client = new Client({ name: "control-plane-run-scope-test", version: "1.0.0" });
    try {
      await client.connect(createHttpTransport(server.endpoint));
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(["get_run", "list_runs"]);
      await expect(
        client.callTool({ name: "start_run", arguments: { goal: "synthetic" } }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "control_plane_scope_required" }],
      });
      await expect(
        client.callTool({
          name: "continue_run",
          arguments: { runId: Id.parse("00000000000000000000000005"), goal: "synthetic" },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "control_plane_scope_required" }],
      });
      expect(startRun).not.toHaveBeenCalled();
      expect(continueRun).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("delivers ordered, content-free run resource updates over subscriptions/listen", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    await store.append(
      runId,
      [builders.runCreated(runId), builders.runStatusChanged(runId, "pending", "running")],
      0,
    );
    const server = await startControlPlaneHttp(store, 0, controlPlaneOptions());
    const client = new Client(
      { name: "control-plane-run-updates-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const updates: string[] = [];
    client.setNotificationHandler(
      "notifications/resources/updated",
      { params: z.object({ uri: z.string() }).passthrough() },
      ({ uri }) => {
        updates.push(uri);
      },
    );
    const runUri = RUN_RESOURCE_URI_TEMPLATE.replace("{runId}", runId);
    let subscription: Awaited<ReturnType<typeof client.listen>> | undefined;
    try {
      await client.connect(createHttpTransport(server.endpoint));
      subscription = await client.listen({
        resourceSubscriptions: [RUNS_RESOURCE_URI, runUri],
      });

      const canary = "MCP_RUN_UPDATE_CONTENT_CANARY";
      await store.append(runId, [builders.modelRequest(runId, canary)], 2);
      await store.append(
        runId,
        [builders.checkpointWritten(runId, builders.nextRunId(), 101)],
        3,
      );
      await vi.waitFor(() => {
        expect(updates).toEqual([RUNS_RESOURCE_URI, runUri, RUNS_RESOURCE_URI, runUri]);
      });

      expect(JSON.stringify(updates)).not.toContain(canary);
    } finally {
      await subscription?.close();
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("conceals approvals outside a token's run filter for approve and deny", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const hiddenRunId = builders.nextRunId();
    const hiddenCallId = builders.nextRunId();
    const hiddenApprovalId = builders.nextRunId();
    const allowedRunId = builders.nextRunId();
    await store.append(
      hiddenRunId,
      [
        builders.runCreated(hiddenRunId),
        builders.runStatusChanged(hiddenRunId, "pending", "running"),
        {
          runId: hiddenRunId,
          ts: 3,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: hiddenRunId,
          type: "tool_intent",
          callId: hiddenCallId,
          toolId: "tool.synthetic",
          idempotent: false,
          policyDecision: "ask",
          ruleId: "approval.synthetic",
          argsHash: "c".repeat(64),
          args: { private: "approval payload" },
        },
        {
          runId: hiddenRunId,
          ts: 4,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: hiddenRunId,
          type: "approval_requested",
          approvalId: hiddenApprovalId,
          callId: hiddenCallId,
          payload: {
            payloadVersion: 1,
            kind: "tool_call",
            callId: hiddenCallId,
            toolId: "tool.synthetic",
            args: { private: "approval payload" },
            ruleId: "approval.synthetic",
            reason: "policy.ask",
            summary: "Review this request.",
            ui: {
              resourceUri: "ui://harness/approval/v1",
              fallbackText: "Review the tokenized approval.",
            },
            editableFields: [],
          },
        },
        builders.runStatusChanged(hiddenRunId, "running", "suspended"),
      ],
      0,
    );
    await store.append(
      allowedRunId,
      [
        builders.runCreated(allowedRunId),
        builders.runStatusChanged(allowedRunId, "pending", "running"),
      ],
      0,
    );
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({}, ["approve"], [allowedRunId]),
    );
    const client = new Client({ name: "control-plane-approval-scope-test", version: "1.0.0" });
    try {
      await client.connect(createHttpTransport(server.endpoint));
      for (const name of ["approve", "deny"] as const) {
        const hidden = await client.callTool({
          name,
          arguments: { approvalId: hiddenApprovalId },
        });
        const missing = await client.callTool({
          name,
          arguments: { approvalId: builders.nextRunId() },
        });
        expect(hidden).toEqual(missing);
        expect(hidden).toMatchObject({
          isError: true,
          structuredContent: { ok: false, code: "approval_not_found" },
        });
      }
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("serves the same tools over loopback and rejects invalid Host and Origin headers", async () => {
    const store = new InMemoryEventStore();
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({ approvalHtml: "<html>test</html>" }),
    );
    const client = new Client({ name: "control-plane-http-test", version: "1.0.0" });
    const transport = createHttpTransport(server.endpoint);
    try {
      expect(new URL(server.endpoint).hostname).toBe("127.0.0.1");
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "cancel_run",
        "continue_run",
        "get_run",
        "list_runs",
        "resume_run",
        "start_run",
      ]);
      await expect(client.callTool({ name: "list_runs", arguments: {} })).resolves.toMatchObject({
        structuredContent: { runs: [] },
        content: [{ text: "0 runs." }],
      });

      await expect(sendMcpRequest(server.endpoint, { host: "untrusted.example" })).resolves.toBe(
        403,
      );
      await expect(
        sendMcpRequest(server.endpoint, { origin: "http://untrusted.example" }),
      ).resolves.toBe(403);
      await expect(fetch(server.endpoint.replace("/mcp", "/other"))).resolves.toMatchObject({
        status: 404,
      });
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("shares resume supervision across requests and propagates later cancellation", async () => {
    const store = new InMemoryEventStore();
    let resumeSignal: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    let markAborted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({
        approvalHtml: "<html>test</html>",
        maxConcurrentRuns: 1,
        isAppContext: () => true,
        operations: {
          resumeRun: (_runId, signal, onClaimed) => {
            resumeSignal = signal;
            onClaimed();
            markStarted();
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  markAborted();
                  resolve({ status: "suspended" });
                },
                { once: true },
              );
            });
          },
          cancelRun: () => Promise.resolve("cancelled"),
        },
      }),
    );
    const firstClient = new Client({ name: "control-plane-http-first", version: "1.0.0" });
    const secondClient = new Client({ name: "control-plane-http-second", version: "1.0.0" });
    try {
      await firstClient.connect(createHttpTransport(server.endpoint));
      await secondClient.connect(createHttpTransport(server.endpoint));
      const firstRunId = Id.parse("00000000000000000000000001");
      const secondRunId = Id.parse("00000000000000000000000002");

      await expect(
        firstClient.callTool({ name: "resume_run", arguments: { runId: firstRunId } }),
      ).resolves.toMatchObject({ structuredContent: { started: true } });
      await started;
      await expect(
        secondClient.callTool({ name: "resume_run", arguments: { runId: secondRunId } }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: { started: false, code: "capacity_exceeded" },
      });
      await expect(
        secondClient.callTool({ name: "cancel_run", arguments: { runId: firstRunId } }),
      ).resolves.toMatchObject({ structuredContent: { ok: true } });
      await aborted;

      expect(resumeSignal?.aborted).toBe(true);
    } finally {
      await firstClient.close();
      await secondClient.close();
      await server.close();
      await store.close();
    }
  });

  it("shares the reveal rate limit across stateless HTTP tool requests", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const callId = builders.nextRunId();
    const approvalId = builders.nextRunId();
    const args = { email: Token.parse("<EMAIL_1>") };
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
        type: "tool_intent",
        callId,
        toolId: "tool.synthetic",
        idempotent: false,
        policyDecision: "ask",
        argsHash: "c".repeat(64),
        args,
      },
      {
        runId,
        ts: 3,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        type: "approval_requested",
        approvalId,
        callId,
        payload: {
          payloadVersion: 1,
          kind: "tool_call",
          callId,
          toolId: "tool.synthetic",
          args,
          ruleId: "approval.synthetic",
          reason: "policy.ask",
          summary: "Review this request.",
          ui: {
            resourceUri: "ui://harness/approval/v1",
            fallbackText: "Review the tokenized approval.",
          },
          editableFields: [],
        },
      },
      builders.runStatusChanged(runId, "running", "suspended"),
    ];
    await store.append(runId, events, 0);
    const resolver = new AuditingVaultResolver(
      { resolve: () => Promise.resolve("synthetic@example.test") },
      () => undefined,
    );
    const server = await startControlPlaneHttp(
      store,
      0,
      controlPlaneOptions({
        approvalHtml: "<html>test</html>",
        isAppContext: () => true,
        approvalApp: {
          allowReveal: true,
          authorize: (_context, scope) => ({
            allowed: scope === "reveal",
            tokenId: Code.parse("token.http"),
            principal: "token.token.http",
          }),
          vaultResolver: resolver,
        },
      }),
    );
    const client = new Client({ name: "approval-rate-test", version: "1.0.0" });
    const transport = createHttpTransport(server.endpoint);
    try {
      await client.connect(transport);
      await expect(
        client.callTool({
          name: "harness.approvals.resolve",
          arguments: { approvalId, decision: "approve" },
        }),
      ).resolves.toMatchObject({
        structuredContent: { ok: false, code: "approval_not_found" },
      });
      for (let index = 0; index < 5; index += 1) {
        await expect(
          client.callTool({
            name: "harness.approvals.reveal",
            arguments: { approvalId, pointers: ["/email"] },
          }),
        ).resolves.toMatchObject({
          structuredContent: {
            values: [{ pointer: "/email", value: "synthetic@example.test" }],
          },
        });
      }
      await expect(
        client.callTool({
          name: "harness.approvals.reveal",
          arguments: { approvalId, pointers: ["/email"] },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "rate_limited" }],
      });
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });
});
