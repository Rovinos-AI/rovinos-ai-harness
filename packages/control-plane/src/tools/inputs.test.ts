// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ClientOptions } from "@modelcontextprotocol/client";
import { Code, Id, type NewEvent } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { createControlPlaneServer } from "../server.js";
import type { ResolveInputOperation } from "./answer-input.js";
import { listInputRequests } from "./input-state.js";

interface Connection {
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
  readonly store: InMemoryEventStore;
}

const connections: Connection[] = [];

async function createPendingInput(
  store: InMemoryEventStore,
  mode: "form" | "url" = "form",
): Promise<{ readonly runId: Id; readonly requestId: Id }> {
  const runId = Id.parse("A".repeat(26));
  const callId = Id.parse("B".repeat(26));
  const requestId = Id.parse("C".repeat(26));
  const envelope = {
    runId,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
  };
  const events: NewEvent[] = [
    {
      ...envelope,
      ts: 1,
      v: 1,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    },
    {
      ...envelope,
      ts: 2,
      v: 1,
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "started",
    },
    {
      ...envelope,
      ts: 3,
      v: 1,
      type: "tool_intent",
      callId,
      toolId: Code.parse("mcp.synthetic"),
      idempotent: true,
      policyDecision: "allow",
      argsHash: "d".repeat(64),
      args: {},
    },
    {
      ...envelope,
      ts: 4,
      v: 1,
      type: "input_requested",
      requestId,
      source: "mcp_mrtr",
      serverId: Code.parse("mcp.synthetic"),
      callId,
      inputKey: "account",
      round: 1,
      mode,
      message: "Input message <EMAIL_1>",
      ...(mode === "form"
        ? {
            schema: {
              type: "object" as const,
              properties: { name: { type: "string" as const } },
              required: ["name"],
            },
          }
        : { url: "https://accounts.example.test/connect" }),
    },
    {
      ...envelope,
      ts: 5,
      v: 1,
      type: "run_status_changed",
      from: "running",
      to: "suspended",
      reason: "awaiting_input",
    },
  ];
  await store.append(runId, events, 0);
  return { runId, requestId };
}

async function connect(
  store: InMemoryEventStore,
  options: {
    readonly resolveInput?: ResolveInputOperation;
    readonly capabilities?: ClientOptions["capabilities"];
    readonly response?: {
      readonly action: "accept" | "decline" | "cancel";
      readonly content?: Readonly<Record<string, string>>;
    };
    readonly protocol?: "auto" | "legacy";
    readonly isAppContext?: boolean;
    readonly onAudit?: ControlPlaneAuditHandler;
  } = {},
): Promise<{ readonly client: Client; readonly received: unknown[] }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    confirmation: { key: Buffer.alloc(32, 19) },
    isAppContext: () => options.isAppContext === true,
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
    operations: {
      ...(options.resolveInput === undefined ? {} : { resolveInput: options.resolveInput }),
    },
  });
  const client = new Client(
    { name: "input-tools-test", version: "1.0.0" },
    {
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      versionNegotiation: { mode: options.protocol ?? "auto" },
    },
  );
  const received: unknown[] = [];
  if (options.response !== undefined) {
    client.setRequestHandler("elicitation/create", (request) => {
      received.push(request);
      return {
        action: options.response?.action ?? "cancel",
        ...(options.response?.content === undefined ? {} : { content: options.response.content }),
      };
    });
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server, store });
  return { client, received };
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

describe("control-plane human input tools", () => {
  it("lists metadata and returns tokenized request content only from get_input", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store);
    const { client } = await connect(store);

    const listed = await client.callTool({ name: "list_pending_inputs", arguments: {} });
    const fetched = await client.callTool({
      name: "get_input",
      arguments: { requestId },
    });

    expect(listed.structuredContent).toMatchObject({
      inputs: [{ requestId, runId, source: "mcp_mrtr", mode: "form", round: 1 }],
    });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("Input message");
    expect(fetched.structuredContent).toMatchObject({
      requestId,
      runId,
      message: "Input message <EMAIL_1>",
      schema: { properties: { name: { type: "string" } } },
    });
  });

  it("limits pending-input listings to the requested run ids", async () => {
    const store = new InMemoryEventStore();
    const { runId } = await createPendingInput(store);

    await expect(listInputRequests(store, 10, [runId])).resolves.toMatchObject([
      { runId, source: "mcp_mrtr" },
    ]);
    await expect(listInputRequests(store, 10, [Id.parse("D".repeat(26))])).resolves.toEqual([]);
  });

  it.each([
    { protocol: "auto" as const, mode: "form" as const },
    { protocol: "legacy" as const, mode: "form" as const },
  ])("relays a $mode input over the $protocol SDK client", async ({ protocol, mode }) => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store, mode);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const { client, received } = await connect(store, {
      protocol,
      capabilities: { elicitation: { form: {} } },
      response: { action: "accept", content: { name: "Ada" } },
      resolveInput,
    });

    const result = await client.callTool({
      name: "review_input",
      arguments: { requestId },
    });

    expect(result.structuredContent).toEqual({ resolved: true });
    expect(resolveInput).toHaveBeenCalledWith({
      runId,
      requestId,
      action: "accept",
      answer: { name: "Ada" },
      principal: "cli.control_plane",
    });
    expect(JSON.stringify(received)).toContain(`run ${runId}`);
    expect(JSON.stringify(received)).toContain("MCP server mcp.synthetic");
    expect(JSON.stringify(received)).not.toContain("RAW_INPUT_CANARY");
  });

  it("relays URL mode with the SDK's URL request builder and requires its capability", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store, "url");
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const { client, received } = await connect(store, {
      capabilities: { elicitation: { url: {} } },
      response: { action: "accept" },
      resolveInput,
    });

    const result = await client.callTool({ name: "review_input", arguments: { requestId } });

    expect(result.structuredContent).toEqual({ resolved: true });
    expect(received[0]).toMatchObject({
      params: {
        mode: "url",
        url: "https://accounts.example.test/connect",
        message: expect.stringContaining(`run ${runId}`),
      },
    });
    expect(resolveInput).toHaveBeenCalledWith({
      runId,
      requestId,
      action: "accept",
      principal: "cli.control_plane",
    });
  });

  it("provides terminal instructions when the connected client lacks elicitation", async () => {
    const store = new InMemoryEventStore();
    const { requestId } = await createPendingInput(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const { client } = await connect(store, { resolveInput });

    const result = await client.callTool({ name: "review_input", arguments: { requestId } });

    expect(result.structuredContent).toMatchObject({
      resolved: false,
      code: "human_confirmation_unavailable",
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining(`harness inputs answer ${requestId}`) }),
    );
    expect(resolveInput).not.toHaveBeenCalled();
  });

  it("keeps input messages and answers out of control-plane audit records", async () => {
    const store = new InMemoryEventStore();
    const { requestId } = await createPendingInput(store);
    const audit = vi.fn<ControlPlaneAuditHandler>();
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const { client } = await connect(store, {
      capabilities: { elicitation: { form: {} } },
      response: { action: "accept", content: { name: "RAW_INPUT_CANARY" } },
      resolveInput,
      onAudit: audit,
    });

    await client.callTool({ name: "review_input", arguments: { requestId } });

    expect(JSON.stringify(audit.mock.calls)).not.toContain("Input message");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("RAW_INPUT_CANARY");
  });

  it("keeps app answers hidden from model clients and records the answering principal", async () => {
    const store = new InMemoryEventStore();
    const { requestId, runId } = await createPendingInput(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const { client } = await connect(store, { isAppContext: true, resolveInput });
    const visibleTools = await client.listTools();

    const result = await client.callTool({
      name: "answer_input",
      arguments: { requestId, action: "accept", answer: { name: "Ada" } },
    });

    expect(visibleTools.tools.map(({ name }) => name)).not.toContain("answer_input");
    expect(result.structuredContent).toEqual({ resolved: true });
    expect(resolveInput).toHaveBeenCalledWith({
      runId,
      requestId,
      action: "accept",
      answer: { name: "Ada" },
      principal: "cli.control_plane",
    });
  });
});
