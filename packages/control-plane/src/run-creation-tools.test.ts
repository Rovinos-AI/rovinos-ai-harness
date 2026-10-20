// SPDX-License-Identifier: Apache-2.0
import { ControlPlaneConfigSchema, Id, Principal } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneServer } from "./server.js";

const CONTENT_CANARY = "RUN_INPUT_PRIVATE_CANARY";
const runId = Id.parse("00000000000000000000000001");
const continuationId = Id.parse("00000000000000000000000002");

const connections: Array<{
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
}> = [];

async function connect(
  store: InMemoryEventStore,
  options: Parameters<typeof createControlPlaneServer>[1] = {},
  elicitation = true,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    approvalHtml: "<html>test</html>",
    confirmation: { key: Buffer.alloc(32, 23) },
    ...options,
  });
  const client = new Client(
    { name: "run-creation-test", version: "1.0.0" },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (elicitation) {
    client.setRequestHandler("elicitation/create", () => ({
      action: "accept",
      content: { confirm: true },
    }));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

describe("control-plane run creation tools", () => {
  it("starts and continues with the run scope, principal attribution, and safe outputs", async () => {
    const store = new InMemoryEventStore();
    const startRun = vi.fn(({ goal, idempotencyKey, requestedBy }) => {
      expect(goal).toBe(CONTENT_CANARY);
      expect(idempotencyKey).toBe("request-key");
      expect(requestedBy).toBe(Principal.parse("token.local"));
      return Promise.resolve({ runId, status: "pending" as const });
    });
    const continueRun = vi.fn((_sourceRunId, input) => {
      expect(input.requestedBy).toBe(Principal.parse("token.local"));
      return Promise.resolve({ runId: continuationId, status: "pending" as const });
    });
    const client = await connect(store, {
      controlPlane: ControlPlaneConfigSchema.parse({ allowAgentStartedRuns: true }),
      operations: { startRun, continueRun },
    });

    const started = await client.callTool({
      name: "start_run",
      arguments: { goal: CONTENT_CANARY, idempotencyKey: "request-key" },
    });
    const continued = await client.callTool({
      name: "continue_run",
      arguments: { runId, goal: "Follow up" },
    });

    expect(started.structuredContent).toEqual({ runId, status: "pending" });
    expect(continued.structuredContent).toEqual({ runId: continuationId, status: "pending" });
    expect(`${JSON.stringify(started)}${JSON.stringify(continued)}`).not.toContain(CONTENT_CANARY);
    expect(startRun).toHaveBeenCalledOnce();
    expect(continueRun).toHaveBeenCalledOnce();
  });

  it("requires human confirmation for a model-driven start unless explicitly enabled", async () => {
    const store = new InMemoryEventStore();
    const startRun = vi.fn(() => Promise.resolve({ runId, status: "pending" as const }));
    const client = await connect(store, { operations: { startRun } }, false);

    const result = await client.callTool({
      name: "start_run",
      arguments: { goal: CONTENT_CANARY },
    });

    expect(result.structuredContent).toEqual({ code: "human_confirmation_unavailable" });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
    expect(startRun).not.toHaveBeenCalled();
    expect(await store.listRuns({ limit: 10 })).toEqual({ runs: [] });
  });

  it("requires human confirmation for a model-driven continuation", async () => {
    const store = new InMemoryEventStore();
    const continueRun = vi.fn();
    const client = await connect(store, { operations: { continueRun } }, false);

    const result = await client.callTool({
      name: "continue_run",
      arguments: { runId, goal: CONTENT_CANARY },
    });

    expect(result.structuredContent).toEqual({ code: "human_confirmation_unavailable" });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("checks continuation quota before invoking the writer and hides operation errors", async () => {
    const store = new InMemoryEventStore();
    const continueRun = vi.fn(() => Promise.reject(new Error(CONTENT_CANARY)));
    const client = await connect(store, {
      operations: {
        continueRun,
        checkRunQuota: () => Promise.reject({ code: "quota_exceeded" }),
      },
    });

    const quotaResult = await client.callTool({
      name: "continue_run",
      arguments: { runId, goal: CONTENT_CANARY },
    });
    expect(quotaResult.structuredContent).toEqual({ code: "quota_exceeded" });
    expect(JSON.stringify(quotaResult)).not.toContain(CONTENT_CANARY);
    expect(continueRun).not.toHaveBeenCalled();

    const failedClient = await connect(store, {
      operations: { continueRun },
    });
    const failure = await failedClient.callTool({
      name: "continue_run",
      arguments: { runId, goal: CONTENT_CANARY },
    });
    expect(failure.structuredContent).toEqual({ code: "continue_run_failed" });
    expect(JSON.stringify(failure)).not.toContain(CONTENT_CANARY);
    expect(continueRun).toHaveBeenCalledOnce();
  });

  it("reports when the continuation runtime is unavailable", async () => {
    const client = await connect(new InMemoryEventStore(), { operations: {} });

    const result = await client.callTool({
      name: "continue_run",
      arguments: { runId, goal: "Follow up" },
    });

    expect(result.structuredContent).toEqual({ code: "control_plane_runtime_unavailable" });
  });

  it("returns the same run for a repeated idempotency key without echoing content", async () => {
    const store = new InMemoryEventStore();
    const seen = new Map<string, typeof runId>();
    const startRun = vi.fn(({ idempotencyKey }) => {
      const existing = seen.get(idempotencyKey ?? "");
      if (existing !== undefined) {
        return Promise.resolve({ runId: existing, status: "pending" as const });
      }
      seen.set(idempotencyKey ?? "", runId);
      return Promise.resolve({ runId, status: "pending" as const });
    });
    const client = await connect(store, {
      controlPlane: ControlPlaneConfigSchema.parse({ allowAgentStartedRuns: true }),
      operations: { startRun },
    });
    const args = { goal: CONTENT_CANARY, idempotencyKey: "repeat-key" };

    const first = await client.callTool({ name: "start_run", arguments: args });
    const second = await client.callTool({ name: "start_run", arguments: args });

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(first.structuredContent).toEqual({ runId, status: "pending" });
    expect(JSON.stringify([first, second])).not.toContain(CONTENT_CANARY);
    expect(startRun).toHaveBeenCalledTimes(2);
  });

  it("checks quota before invoking the run writer and maps failures to a safe code", async () => {
    const store = new InMemoryEventStore();
    const startRun = vi.fn(() => Promise.resolve({ runId, status: "pending" as const }));
    const client = await connect(store, {
      controlPlane: ControlPlaneConfigSchema.parse({ allowAgentStartedRuns: true }),
      operations: {
        startRun,
        checkRunQuota: () => Promise.reject({ code: "quota_exceeded" }),
      },
    });

    const result = await client.callTool({
      name: "start_run",
      arguments: { goal: CONTENT_CANARY },
    });

    expect(result.structuredContent).toEqual({ code: "quota_exceeded" });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
    expect(startRun).not.toHaveBeenCalled();
    expect(await store.listRuns({ limit: 10 })).toEqual({ runs: [] });
  });

  it("does not return content embedded in an operation error", async () => {
    const store = new InMemoryEventStore();
    const client = await connect(store, {
      controlPlane: ControlPlaneConfigSchema.parse({ allowAgentStartedRuns: true }),
      operations: {
        startRun: () => Promise.reject(new Error(CONTENT_CANARY)),
      },
    });

    const result = await client.callTool({
      name: "start_run",
      arguments: { goal: CONTENT_CANARY },
    });

    expect(result.structuredContent).toEqual({ code: "start_run_failed" });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
  });
});
