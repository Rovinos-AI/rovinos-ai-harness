// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryTransport,
  Client,
  type Client as McpClient,
  type InMemoryTransport as MemoryTransport,
} from "@modelcontextprotocol/client";
import {
  EVENT_FIELD_CLASS,
  EventSchema,
  Id,
  eventSamples,
  type EventType,
  type NewEvent,
  type RunStatus,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const contentFields = Object.entries(EVENT_FIELD_CLASS).flatMap(([type, fields]) =>
  Object.entries(fields)
    .filter(([, fieldClass]) => fieldClass === "content")
    .map(([field]) => ({ type, field })),
);

function contentCanaryValue(type: EventType, field: string, canary: string): unknown {
  if (type === "model_request" && field === "messages") {
    return [{ role: "user", parts: [{ type: "text", text: canary }] }];
  }
  if (type === "model_response" && field === "content") {
    return [{ type: "text", text: canary }];
  }
  return canary;
}

function eventsWithContentCanaries(runId: Id, canaries: readonly string[]): NewEvent[] {
  let canaryIndex = 0;
  const events: NewEvent[] = [];
  for (const sample of eventSamples) {
    const event: Record<string, unknown> = { ...sample, runId, segmentId: runId };
    for (const [field, fieldClass] of Object.entries(EVENT_FIELD_CLASS[sample.type])) {
      if (fieldClass !== "content") {
        continue;
      }
      const canary = canaries[canaryIndex];
      if (canary === undefined) {
        throw new Error("Missing generated content canary.");
      }
      event[field] = contentCanaryValue(sample.type, field, canary);
      canaryIndex += 1;
    }
    events.push(EventSchema.parse(event));
  }
  if (canaryIndex !== canaries.length) {
    throw new Error("Unused generated content canary.");
  }
  return events;
}

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
  vi.restoreAllMocks();
});

describe("control-plane inspection tools", () => {
  it("registers both read-only tools with structured schemas and safe annotations", async () => {
    const store = new InMemoryEventStore();
    const { client } = await connect(store);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual(["get_run", "list_runs"]);
    expect(
      tools.every(
        ({ annotations }) =>
          annotations?.readOnlyHint === true &&
          annotations.idempotentHint === true &&
          annotations.openWorldHint === false,
      ),
    ).toBe(true);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()).not.toHaveProperty("extensions");
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
    expect(output.recentEvents.every(({ policyVersion }) => policyVersion === "policy.v1")).toBe(
      true,
    );
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

  it("keeps generated content canaries out of both tools across statuses and pages", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.nat(), {
          minLength: contentFields.length,
          maxLength: contentFields.length,
        }),
        async (suffixes) => {
          const store = new InMemoryEventStore();
          const builders = createEventBuilders();
          const runId = builders.nextRunId();
          const canaries = suffixes.map(
            (suffix, index) => `GENERATED_CONTENT_CANARY_${index}_${suffix}`,
          );
          await store.append(runId, eventsWithContentCanaries(runId, canaries), 0);
          await addRun(store, builders);
          const { client } = await connect(store);

          const assertCanaryFree = (result: {
            readonly structuredContent?: unknown;
            readonly content?: readonly unknown[];
          }) => {
            const output = JSON.stringify({
              structuredContent: result.structuredContent,
              content: result.content,
            });
            for (const canary of canaries) {
              expect(output).not.toContain(canary);
            }
          };

          for (const status of [
            "pending",
            "running",
            "suspended",
            "completed",
            "failed",
            "cancelled",
          ] as const) {
            const result = await client.callTool({
              name: "list_runs",
              arguments: { status, limit: 1 },
            });
            assertCanaryFree(result);
          }

          let cursor: string | undefined;
          do {
            const result = await client.callTool({
              name: "list_runs",
              arguments: { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
            });
            assertCanaryFree(result);
            cursor = listRunsOutputSchema.parse(result.structuredContent).nextCursor;
          } while (cursor !== undefined);

          const detailed = await client.callTool({
            name: "get_run",
            arguments: { runId },
          });
          assertCanaryFree(detailed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("bounds metadata counts to the run summary sequence", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    await store.append(
      runId,
      [builders.runCreated(runId), builders.runStatusChanged(runId, "pending", "running")],
      0,
    );
    const summary = (await store.listRuns({ limit: 1 })).runs[0];
    if (summary === undefined) {
      throw new Error("Missing run summary.");
    }
    const response = eventSamples.find((event) => event.type === "model_response");
    if (response?.type !== "model_response") {
      throw new Error("Missing model-response event fixture.");
    }
    await store.append(runId, [{ ...response, runId, segmentId: runId }], summary.lastSeq + 1);
    const listRunsSpy = vi.spyOn(store, "listRuns").mockResolvedValue({ runs: [summary] });
    const readSpy = vi.spyOn(store, "read");

    const output = await listRuns(store, {});

    expect(output.runs[0]?.steps).toBe(0);
    expect(readSpy).toHaveBeenCalledWith(runId, { toSeq: summary.lastSeq });
    expect(listRunsSpy).toHaveBeenCalledOnce();
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
