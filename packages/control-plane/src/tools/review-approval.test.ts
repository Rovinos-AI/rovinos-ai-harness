// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { Code, type Id, type NewEvent } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneServer } from "../server.js";
import type { ResolveApprovalOperation } from "./approve.js";

const RAW_CANARY = "RAW_APPROVAL_SECRET_CANARY";

interface Connection {
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
  readonly store: InMemoryEventStore;
}

const connections: Connection[] = [];

async function createApproval(
  store: InMemoryEventStore,
  editable = false,
): Promise<{ readonly runId: Id; readonly approvalId: Id }> {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const callId = builders.nextRunId();
  const approvalId = builders.nextRunId();
  const events: NewEvent[] = [
    builders.runCreated(runId),
    builders.runStatusChanged(runId, "pending", "running"),
    {
      runId,
      ts: 3,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "tool_intent",
      callId,
      toolId: Code.parse("tool.synthetic"),
      idempotent: false,
      policyDecision: "ask",
      ruleId: Code.parse("approval.synthetic"),
      argsHash: "c".repeat(64),
      args: { private: RAW_CANARY },
    },
    {
      runId,
      ts: 4,
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
        toolId: Code.parse("tool.synthetic"),
        args: { private: RAW_CANARY },
        ruleId: Code.parse("approval.synthetic"),
        reason: Code.parse("policy.ask"),
        summary: "Review this request.",
        ui: {
          resourceUri: "ui://harness/approval/v1",
          fallbackText: "Review tokenized request for tool.synthetic.",
        },
        editableFields: editable ? ["/private"] : [],
      },
    },
    builders.runStatusChanged(runId, "running", "suspended"),
  ];
  await store.append(runId, events, 0);
  return { runId, approvalId };
}

function resolutionOperation(store: InMemoryEventStore): ResolveApprovalOperation {
  return async ({ runId, approvalId, decision, approverId }) => {
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    await store.append(
      runId,
      [
        {
          runId,
          ts: 20,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: runId,
          type: "approval_resolved",
          approvalId,
          decision,
          decidedBy: "human",
          approverId,
          waitMs: 16,
        },
      ],
      events.length,
    );
  };
}

async function connect(
  store: InMemoryEventStore,
  options: {
    readonly response?: {
      readonly action: "accept" | "decline" | "cancel";
      readonly content?: { readonly decision: "approve" | "deny"; readonly reason?: string };
    };
    readonly consoleUrl?: string;
    readonly resolveApproval?: ResolveApprovalOperation;
  } = {},
): Promise<{ readonly client: Client; readonly receivedElicitations: unknown[] }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    approvalHtml: "<html>test</html>",
    runsConsoleHtml: "<html>runs test</html>",
    confirmation: { key: Buffer.alloc(32, 19) },
    ...(options.consoleUrl === undefined ? {} : { consoleUrl: options.consoleUrl }),
    operations: {
      resolveApproval: options.resolveApproval ?? resolutionOperation(store),
    },
  });
  const client = new Client(
    { name: "review-approval-test", version: "1.0.0" },
    options.response === undefined ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  const receivedElicitations: unknown[] = [];
  if (options.response !== undefined) {
    client.setRequestHandler("elicitation/create", (request) => {
      receivedElicitations.push(request);
      return {
        action: options.response?.action ?? "cancel",
        ...(options.response?.content === undefined ? {} : { content: options.response.content }),
      };
    });
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server, store });
  return { client, receivedElicitations };
}

async function resolutionCount(store: InMemoryEventStore, runId: Id): Promise<number> {
  let count = 0;
  for await (const event of store.read(runId)) {
    if (event.type === "approval_resolved") {
      count += 1;
    }
  }
  return count;
}

function textContent(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  const textBlock = content.find(({ type }) => type === "text");
  return textBlock !== undefined && "text" in textBlock && typeof textBlock.text === "string"
    ? textBlock.text
    : "";
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ client, server, store }) => {
      await client.close();
      await server.close();
      await store.close();
    }),
  );
  vi.restoreAllMocks();
});

describe("review_approval", () => {
  it.each([{ decision: "approve" as const }, { decision: "deny" as const, reason: "reviewed" }])(
    "applies an explicitly accepted $decision answer",
    async (answer) => {
      const store = new InMemoryEventStore();
      const approval = await createApproval(store);
      const resolveApproval = vi.fn(resolutionOperation(store));
      const { client, receivedElicitations } = await connect(store, {
        response: { action: "accept", content: answer },
        resolveApproval,
      });

      const result = await client.callTool({
        name: "review_approval",
        arguments: { approvalId: approval.approvalId },
      });

      expect(result).toMatchObject({ structuredContent: { resolved: true } });
      expect(resolveApproval).toHaveBeenCalledWith({
        runId: approval.runId,
        approvalId: approval.approvalId,
        decision: answer.decision,
        approverId: "cli.control_plane",
        ...(answer.decision === "deny" ? { reason: Code.parse("reviewed") } : {}),
      });
      expect(await resolutionCount(store, approval.runId)).toBe(1);
      expect(JSON.stringify(receivedElicitations)).toContain("Review tokenized request");
      expect(JSON.stringify(receivedElicitations)).not.toContain(RAW_CANARY);
      expect(JSON.stringify(result)).not.toContain(RAW_CANARY);
      expect(receivedElicitations[0]).toMatchObject({
        params: {
          message: "Review tokenized request for tool.synthetic.",
          requestedSchema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["approve", "deny"] },
              reason: {
                type: "string",
                enum: ["reviewed", "not_approved", "policy_violation", "risk_unacceptable"],
              },
            },
            required: ["decision"],
          },
        },
      });
      expect(JSON.stringify(receivedElicitations[0])).not.toContain("edits");
    },
  );

  it("adds fixed edit guidance to elicitation for editable approvals", async () => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store, true);
    const { client, receivedElicitations } = await connect(store, {
      response: { action: "cancel" },
    });

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId: approval.approvalId },
    });

    expect(result.structuredContent).toEqual({ resolved: false });
    const requests = receivedElicitations[0];
    expect(requests).toMatchObject({
      params: {
        message:
          "Review tokenized request for tool.synthetic. Edits are not available in this form; use the CLI with --edit <json-file> or the approval app.",
      },
    });
    expect(JSON.stringify(requests)).not.toContain(RAW_CANARY);
  });

  it("rejects accepted answers with a reason outside the closed enum", async () => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store);
    const resolveApproval = vi.fn(resolutionOperation(store));
    const { client } = await connect(store, {
      response: {
        action: "accept",
        content: { decision: "deny", reason: "free text reason" },
      },
      resolveApproval,
    });

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId: approval.approvalId },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result.content)).toBe("human_input_invalid");
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(await resolutionCount(store, approval.runId)).toBe(0);
  });

  it.each(["decline", "cancel"] as const)(
    "leaves approval state unchanged when the human chooses %s",
    async (action) => {
      const store = new InMemoryEventStore();
      const approval = await createApproval(store);
      const resolveApproval = vi.fn(resolutionOperation(store));
      const { client } = await connect(store, {
        response: { action },
        resolveApproval,
      });

      const result = await client.callTool({
        name: "review_approval",
        arguments: { approvalId: approval.approvalId },
      });

      expect(result.structuredContent).toEqual({ resolved: false });
      expect(resolveApproval).not.toHaveBeenCalled();
      expect(await resolutionCount(store, approval.runId)).toBe(0);
    },
  );

  it("returns CLI and configured console instructions without elicitation support", async () => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store, true);
    const resolveApproval = vi.fn(resolutionOperation(store));
    const { client } = await connect(store, {
      consoleUrl: "https://console.example.test/approvals",
      resolveApproval,
    });

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId: approval.approvalId },
    });

    expect(result.structuredContent).toEqual({ resolved: false });
    const text = textContent(result.content);
    expect(text).toContain(`harness approvals approve ${approval.approvalId}`);
    expect(text).toContain("--edit <json-file>");
    expect(text).toContain("https://console.example.test/approvals");
    expect(text).toContain("approval app");
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(await resolutionCount(store, approval.runId)).toBe(0);

    const tool = (await client.listTools()).tools.find(({ name }) => name === "review_approval");
    expect(tool?.inputSchema.properties).toHaveProperty("approvalId");
    expect(tool?.inputSchema.properties).not.toHaveProperty("edits");
  });

  it("returns instructions without a console URL when none is configured", async () => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store);
    const { client } = await connect(store);

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId: approval.approvalId },
    });

    expect(result.structuredContent).toEqual({ resolved: false });
    const text = textContent(result.content);
    expect(text).toContain(`harness approvals approve ${approval.approvalId}`);
    expect(text).not.toContain("control-plane console");
  });

  it.each(["missing", "resolved"] as const)("fails closed for a %s approval", async (state) => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store);
    const { client } = await connect(store);
    const approvalId =
      state === "missing" ? createEventBuilders().nextRunId() : approval.approvalId;
    if (state === "resolved") {
      await store.append(
        approval.runId,
        [
          {
            runId: approval.runId,
            ts: 5,
            v: 1,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId: approval.runId,
            type: "approval_resolved",
            approvalId: approval.approvalId,
            decision: "deny",
            decidedBy: "human",
            approverId: "cli.test",
            waitMs: 1,
          },
        ],
        5,
      );
    }

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ resolved: false });
    expect(textContent(result.content)).toBe(
      state === "missing" ? "approval_not_found" : "approval_already_resolved",
    );
  });

  it("does not expose raw content when resolution fails", async () => {
    const store = new InMemoryEventStore();
    const approval = await createApproval(store);
    const { client } = await connect(store, {
      response: { action: "accept", content: { decision: "deny" } },
      resolveApproval: () => Promise.reject(new Error(RAW_CANARY)),
    });

    const result = await client.callTool({
      name: "review_approval",
      arguments: { approvalId: approval.approvalId },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ resolved: false });
    expect(textContent(result.content)).toBe("approval_resolution_failed");
    expect(JSON.stringify(result)).not.toContain(RAW_CANARY);
  });
});
