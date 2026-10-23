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
  if (type === "input_requested" && field === "schema") {
    return {
      type: "object",
      description: canary,
      properties: { value: { type: "string" } },
    };
  }
  if (type === "input_requested" && field === "url") {
    return `https://example.test/${encodeURIComponent(canary)}`;
  }
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
  let inputUrlCanary: string | undefined;
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
      if (sample.type === "input_requested" && field === "url") {
        inputUrlCanary = canary;
        canaryIndex += 1;
        continue;
      }
      event[field] = contentCanaryValue(sample.type, field, canary);
      canaryIndex += 1;
    }
    events.push(EventSchema.parse(event));
  }
  if (inputUrlCanary !== undefined) {
    const sample = eventSamples.find(({ type }) => type === "input_requested");
    if (sample?.type !== "input_requested") {
      throw new Error("Missing input-request event sample.");
    }
    const urlEvent: Record<string, unknown> = {
      ...sample,
      runId,
      segmentId: runId,
      mode: "url",
      url: contentCanaryValue("input_requested", "url", inputUrlCanary),
    };
    Reflect.deleteProperty(urlEvent, "schema");
    events.push(EventSchema.parse(urlEvent));
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

async function connect(store: InMemoryEventStore, mcpApps = false): Promise<MemoryConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    approvalHtml: "<html>test</html>",
    runsConsoleHtml: "<html>runs test</html>",
  });
  const client = new Client(
    { name: "control-plane-test", version: "1.0.0" },
    mcpApps
      ? {
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
        }
      : {},
  );
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

    expect(tools.map(({ name }) => name).sort()).toEqual([
      "cancel_run",
      "continue_run",
      "get_run",
      "list_runs",
      "resume_run",
      "start_run",
    ]);
    expect(tools.find(({ name }) => name === "list_runs")?._meta).toEqual({
      ui: { resourceUri: "ui://harness/runs/v1" },
    });
    expect(
      tools
        .filter(({ name }) => name === "list_runs" || name === "get_run")
        .every(
          ({ annotations }) =>
            annotations?.readOnlyHint === true &&
            annotations.idempotentHint === true &&
            annotations.openWorldHint === false,
        ),
    ).toBe(true);
    expect(tools.find(({ name }) => name === "cancel_run")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()).not.toHaveProperty("extensions");
    expect(listRunsInputSchema.parse({})).toEqual({ limit: 20 });
    expect(listRunsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(getRunInputSchema.safeParse({ runId: "invalid" }).success).toBe(false);
  });

  it("lists app-only decision tools only for MCP Apps clients", async () => {
    const store = new InMemoryEventStore();
    const { client } = await connect(store, true);

    const { tools } = await client.listTools();

    expect(tools.find(({ name }) => name === "approve")?._meta).toEqual({
      ui: { visibility: ["app"] },
    });
    expect(tools.find(({ name }) => name === "deny")?._meta).toEqual({
      ui: { visibility: ["app"] },
    });
    expect(tools.find(({ name }) => name === "harness.runs.list")?._meta).toEqual({
      ui: { visibility: ["app"], resourceUri: "ui://harness/runs/v1" },
    });
    expect(tools.find(({ name }) => name === "harness.runs.get")?._meta).toEqual({
      ui: { visibility: ["app"], resourceUri: "ui://harness/runs/v1" },
    });
    expect(tools.find(({ name }) => name === "list_runs")?._meta).toEqual({
      ui: { resourceUri: "ui://harness/runs/v1" },
    });
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

  it("exposes the app-visible copies alongside the model-visible list and get tools", async () => {
    const store = new InMemoryEventStore();
    const runId = await addRun(store, createEventBuilders());
    const { client } = await connect(store, true);

    const listed = await client.callTool({ name: "harness.runs.list", arguments: {} });
    const detailed = await client.callTool({
      name: "harness.runs.get",
      arguments: { runId },
    });
    const names = (await client.listTools()).tools.map(({ name }) => name);

    expect(listRunsOutputSchema.parse(listed.structuredContent).runs).toHaveLength(1);
    expect(getRunOutputSchema.parse(detailed.structuredContent).runId).toBe(runId);
    expect(names).toContain("list_runs");
    expect(names).toContain("harness.runs.list");
    expect(names).toContain("harness.runs.get");
  });

  it("filters a run allowlist before pagination and skips missing IDs", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const completedId = await addRun(store, builders, { status: "completed" });
    const runningId = await addRun(store, builders);
    const missingId = builders.nextRunId();
    const allowedIds = [runningId, completedId, runningId, missingId];

    const first = await listRuns(store, { limit: 1 }, allowedIds);
    const second = await listRuns(store, { limit: 1, cursor: first.nextCursor }, allowedIds);
    const completed = await listRuns(store, { status: "completed", limit: 10 }, allowedIds);
    const invalidCursor = await listRuns(
      store,
      { limit: 1, cursor: "restricted:9007199254740992" },
      allowedIds,
    );

    expect(first.runs).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^restricted:/u);
    expect(second.runs).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.runs, ...second.runs].map(({ runId }) => runId))).toEqual(
      new Set([completedId, runningId]),
    );
    expect(completed.runs.map(({ runId }) => runId)).toEqual([completedId]);
    expect(invalidCursor.runs).toEqual(first.runs);
  });

  it("filters run summaries before reading histories and counts subagent steps consistently", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    await addRun(store, builders);
    await addRun(store, builders);
    const orderedSummaries = await store.listRuns({ limit: 2 });
    const allowedRunId = orderedSummaries.runs[0]?.runId;
    const omittedRunId = orderedSummaries.runs[1]?.runId;
    if (allowedRunId === undefined || omittedRunId === undefined) {
      throw new Error("Missing ordered run fixtures.");
    }
    const modelResponse = eventSamples.find((event) => event.type === "model_response");
    const subagentCompletion = eventSamples.find((event) => event.type === "subagent_completed");
    if (
      modelResponse?.type !== "model_response" ||
      subagentCompletion?.type !== "subagent_completed"
    ) {
      throw new Error("Missing step-count event fixtures.");
    }
    await store.append(
      allowedRunId,
      [
        { ...modelResponse, runId: allowedRunId, segmentId: allowedRunId },
        { ...subagentCompletion, runId: allowedRunId, segmentId: allowedRunId, steps: 3 },
      ],
      await store.head(allowedRunId),
    );
    const firstSummaryPage = await store.listRuns({ limit: 1 });
    expect(firstSummaryPage.runs[0]?.runId).toBe(allowedRunId);
    const readSpy = vi.spyOn(store, "read");

    const restricted = await listRuns(store, { limit: 1 }, [allowedRunId]);

    expect(restricted.runs[0]?.runId).toBe(allowedRunId);
    expect(restricted.runs[0]?.steps).toBe(4);
    const updatedSummary = await store.listRuns({ limit: 1 });
    expect(readSpy).toHaveBeenCalledWith(allowedRunId, {
      toSeq: updatedSummary.runs[0]?.lastSeq,
    });
    expect(readSpy).not.toHaveBeenCalledWith(omittedRunId, expect.anything());

    const unrestricted = await listRuns(store, { limit: 1 });
    expect(unrestricted.runs[0]?.steps).toBe(4);
  });

  it("does not read histories for summaries excluded by the run allowlist", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const newestRunId = await addRun(store, builders);
    const olderRunId = await addRun(store, builders);
    const firstSummaryPage = await store.listRuns({ limit: 1 });
    const selectedRunId = firstSummaryPage.runs[0]?.runId;
    if (selectedRunId === undefined) {
      throw new Error("Missing summary fixture.");
    }
    const nextSummaryPage = await store.listRuns({
      limit: 1,
      ...(firstSummaryPage.nextCursor === undefined ? {} : { cursor: firstSummaryPage.nextCursor }),
    });
    const allowedRunId = nextSummaryPage.runs[0]?.runId;
    if (allowedRunId === undefined) {
      throw new Error("Missing older summary fixture.");
    }
    expect(allowedRunId).not.toBe(selectedRunId);
    expect([newestRunId, olderRunId]).toContain(allowedRunId);
    const readSpy = vi.spyOn(store, "read");

    const skipped = await listRuns(store, { limit: 1 }, [allowedRunId]);

    expect(skipped.runs).toEqual([]);
    expect(skipped.nextCursor).toBeDefined();
    expect(readSpy).not.toHaveBeenCalled();
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
    expect(output.recentEvents).toContainEqual(
      expect.objectContaining({
        kind: "policy_decision",
        toolId: "tool.execute",
        policyDecision: "ask",
        ruleId: "approval.rule",
      }),
    );
    expect(output.recentEvents.every(({ policyVersion }) => policyVersion === "policy.v1")).toBe(
      true,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: `Run metadata: 1 steps, 1 pending approvals, ${String(output.recentEvents.length)} recent safe events.`,
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
    const { client } = await connect(store, true);
    const listed = await client.callTool({ name: "list_runs", arguments: {} });
    const detailed = await client.callTool({ name: "get_run", arguments: { runId } });
    const appListed = await client.callTool({ name: "harness.runs.list", arguments: {} });
    const appDetailed = await client.callTool({
      name: "harness.runs.get",
      arguments: { runId },
    });

    expect(
      `${JSON.stringify(listed)}${JSON.stringify(detailed)}${JSON.stringify(appListed)}${JSON.stringify(appDetailed)}`,
    ).not.toContain(CONTENT_CANARY);
    expect(listRunsOutputSchema.safeParse(listed.structuredContent).success).toBe(true);
    expect(getRunOutputSchema.safeParse(detailed.structuredContent).success).toBe(true);
    expect(listRunsOutputSchema.safeParse(appListed.structuredContent).success).toBe(true);
    expect(getRunOutputSchema.safeParse(appDetailed.structuredContent).success).toBe(true);
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
            (suffix, index) => `GENERATED_CONTENT_CANARY_${String(index)}_${String(suffix)}`,
          );
          await store.append(runId, eventsWithContentCanaries(runId, canaries), 0);
          await addRun(store, builders);
          const { client } = await connect(store, true);

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
          assertCanaryFree(
            await client.callTool({ name: "harness.runs.list", arguments: { limit: 1 } }),
          );
          assertCanaryFree(
            await client.callTool({
              name: "harness.runs.get",
              arguments: { runId },
            }),
          );
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
