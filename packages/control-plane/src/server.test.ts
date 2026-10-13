// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  Client,
  type Client as McpClient,
  type InMemoryTransport as MemoryTransport,
} from "@modelcontextprotocol/client";
import { Id, eventSamples, type NewEvent, type RunStatus } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRun,
  getRunInputSchema,
  getRunOutputSchema,
  getRunText,
  listRuns,
  listRunsInputSchema,
  listRunsOutputSchema,
} from "./index.js";
import { createControlPlaneServer } from "./server.js";

const CONTENT_CANARY = "PRIVATE_EVENT_CONTENT_CANARY";

interface MemoryConnection {
  readonly client: McpClient;
  readonly server: ReturnType<typeof createControlPlaneServer>;
  readonly clientTransport: MemoryTransport;
  readonly serverTransport: MemoryTransport;
}

const connections: MemoryConnection[] = [];

async function connect(store: InMemoryEventStore): Promise<MemoryConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store);
  const client = new Client({ name: "control-plane-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = { client, server, clientTransport, serverTransport };
  connections.push(connection);
  return connection;
}

async function addRun(
  store: InMemoryEventStore,
  builders: ReturnType<typeof createEventBuilders>,
  options: { readonly status?: RunStatus; readonly sensitive?: boolean } = {},
): Promise<Id> {
  const runId = builders.nextRunId();
  const events: NewEvent[] = [
    builders.runCreated(runId),
    builders.runStatusChanged(runId, "pending", "running"),
  ];
  if (options.sensitive === true) {
    events.push(builders.modelRequest(runId, CONTENT_CANARY));
    const response = eventSamples.find((event) => event.type === "model_response");
    if (response?.type !== "model_response") {
      throw new Error("Missing model-response event fixture.");
    }
    events.push({
      ...response,
      runId,
      requestId: builders.nextRunId(),
      content: [{ type: "text", text: CONTENT_CANARY }],
      providerBlobs: CONTENT_CANARY,
    });
    const callId = builders.nextRunId();
    events.push({
      runId,
      ts: 100,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "tool_intent",
      callId,
      toolId: "tool.execute",
      idempotent: false,
      policyDecision: "ask",
      ruleId: "approval.rule",
      argsHash: "c".repeat(64),
      args: { sensitive: CONTENT_CANARY },
    });
    events.push({
      runId,
      ts: 101,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "approval_requested",
      approvalId: builders.nextRunId(),
      callId,
      expiresAt: 500,
      payload: { args: CONTENT_CANARY },
    });
  }
  if (options.status === "completed") {
    events.push(builders.runStatusChanged(runId, "running", "completed"));
  }
  await store.append(runId, events, 0);
  return runId;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async (connection) => {
      await connection.client.close();
      await connection.server.close();
      await connection.clientTransport.close();
      await connection.serverTransport.close();
    }),
  );
});

describe("control-plane inspection tools", () => {
  it("registers both read-only tools with structured schemas and safe annotations", async () => {
    const store = new InMemoryEventStore();
    const { client } = await connect(store);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual(["get_run", "list_runs"]);
    expect(tools.every(({ annotations }) =>
      annotations?.readOnlyHint === true &&
      annotations.idempotentHint === true &&
      annotations.openWorldHint === false
    )).toBe(true);
    expect(listRunsInputSchema.parse({})).toEqual({ limit: 20 });
    expect(listRunsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(getRunInputSchema.safeParse({ runId: "invalid" }).success).toBe(false);
  });

  it("lists metadata with pagination and status filtering", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const completedId = await addRun(store, builders, { status: "completed" });
    await addRun(store, builders);
    await addRun(store, builders);
    const { client } = await connect(store);

    const firstPage = await client.callTool({
      name: "list_runs",
      arguments: { limit: 1 },
    });
    const first = listRunsOutputSchema.parse(firstPage.structuredContent);
    expect(first.runs).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    expect(firstPage.content).toEqual([{ type: "text", text: "1 runs." }]);

    const secondPage = await client.callTool({
      name: "list_runs",
      arguments: { limit: 1, cursor: first.nextCursor },
    });
    const second = listRunsOutputSchema.parse(secondPage.structuredContent);
    expect(second.runs[0]?.runId).not.toBe(first.runs[0]?.runId);

    const completedPage = await client.callTool({
      name: "list_runs",
      arguments: { status: "completed", limit: 10 },
    });
    const completed = listRunsOutputSchema.parse(completedPage.structuredContent);
    expect(completed.runs.map(({ runId }) => runId)).toEqual([completedId]);
  });

  it("returns folded usage, approval metadata, and safe recent events", async () => {
    const store = new InMemoryEventStore();
    const runId = await addRun(store, createEventBuilders(), { sensitive: true });
    const { client } = await connect(store);

    const result = await client.callTool({
      name: "get_run",
      arguments: { runId },
    });
    const output = getRunOutputSchema.parse(result.structuredContent);

    expect(output).toMatchObject({
      runId,
      status: "running",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
      pendingApprovals: [
        {
          toolId: "tool.execute",
          ruleId: "approval.rule",
          expiresAt: 500,
        },
      ],
    });
    expect(output.pendingApprovals[0]?.approvalId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(output.recentEvents.length).toBeGreaterThan(0);
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Run metadata: 1 steps, 1 pending approvals, ${output.recentEvents.length} recent safe events.`,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
  });

  it("returns an error containing only run_not_found for an unknown run", async () => {
    const store = new InMemoryEventStore();
    const { client } = await connect(store);

    const result = await client.callTool({
      name: "get_run",
      arguments: { runId: Id.parse("00000000000000000000000000") },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "run_not_found" }],
    });
    expect(result.structuredContent).toBeUndefined();
  });

  it("does not expose content canaries in any tool output", async () => {
    const store = new InMemoryEventStore();
    const runId = await addRun(store, createEventBuilders(), { sensitive: true });
    const { client } = await connect(store);
    const listed = await client.callTool({ name: "list_runs", arguments: {} });
    const detailed = await client.callTool({ name: "get_run", arguments: { runId } });

    expect(`${JSON.stringify(listed)}${JSON.stringify(detailed)}`).not.toContain(CONTENT_CANARY);
    expect(listRunsOutputSchema.safeParse(listed.structuredContent).success).toBe(true);
    expect(getRunOutputSchema.safeParse(detailed.structuredContent).success).toBe(true);
  });

  it("returns empty lists for an empty store and safe unknown-run text", async () => {
    const store = new InMemoryEventStore();

    await expect(listRuns(store, {})).resolves.toEqual({ runs: [] });
    await expect(getRun(store, { runId: Id.parse("00000000000000000000000000") })).resolves.toBe(
      undefined,
    );
    expect(getRunText(undefined)).toBe("run_not_found");
  });

  it("rejects invalid direct tool inputs", async () => {
    const store = new InMemoryEventStore();

    await expect(listRuns(store, { limit: 0 })).rejects.toThrow();
    await expect(getRun(store, { runId: "not-an-id" })).rejects.toThrow();
    expect(listRunsOutputSchema.safeParse({ runs: [], extra: true }).success).toBe(false);
    expect(getRunOutputSchema.safeParse({ runId: "not-an-id" }).success).toBe(false);
  });
});
