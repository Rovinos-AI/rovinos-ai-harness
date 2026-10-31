// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ClientOptions } from "@modelcontextprotocol/client";
import type { ServerContext } from "@modelcontextprotocol/server";
import { Code, Id, Principal, type NewEvent } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ControlPlaneAuditHandler } from "../auth.js";
import { ConfirmationGate } from "../confirmation-gate.js";
import { createControlPlaneServer } from "../server.js";
import type { ResolveInputOperation } from "./answer-input.js";
import { findPendingInput, listInputRequests } from "./input-state.js";
import { reviewPendingInput } from "./review-input.js";

interface Connection {
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
  readonly store: InMemoryEventStore;
}

const connections: Connection[] = [];

async function createPendingInput(
  store: InMemoryEventStore,
  mode: "form" | "url" = "form",
  runId: Id = Id.parse("A".repeat(26)),
  requestId: Id = Id.parse("C".repeat(26)),
): Promise<{ readonly runId: Id; readonly requestId: Id }> {
  const callId = Id.parse("B".repeat(26));
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
              properties: {
                name: { type: "string" as const },
                tags: { type: "array" as const, items: { type: "string" as const, enum: ["a"] } },
                choices: {
                  type: "array" as const,
                  items: {
                    type: "string" as const,
                    anyOf: [{ const: "a", title: "A" }],
                  },
                },
                score: { type: "number" as const, minimum: 0 },
                active: { type: "boolean" as const },
              },
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

async function resolveSeededInput(
  store: InMemoryEventStore,
  runId: Id,
  requestId: Id,
): Promise<void> {
  await store.append(
    runId,
    [
      {
        runId,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: runId,
        ts: 6,
        v: 1,
        type: "input_resolved",
        requestId,
        source: "mcp_mrtr",
        mode: "form",
        round: 1,
        action: "decline",
        decidedBy: "human",
        approverId: Principal.parse("cli.control_plane"),
        waitMs: 1,
      },
    ],
    5,
  );
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
    readonly captureContext?: (context: ServerContext) => void;
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
  if (options.captureContext !== undefined) {
    server.registerTool(
      "test_capture_context",
      { description: "Test-only context capture", inputSchema: {} },
      (_input, requestContext) => {
        options.captureContext?.(requestContext);
        return { content: [{ type: "text", text: "captured" }] };
      },
    );
  }
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

function context(
  baseContext: ServerContext,
  requestState?: unknown,
  inputResponses?: Readonly<Record<string, unknown>>,
  sessionId?: string,
): ServerContext {
  return {
    ...baseContext,
    ...(sessionId === undefined ? {} : { sessionId }),
    mcpReq: {
      ...baseContext.mcpReq,
      requestState: <T = unknown>() =>
        requestState === undefined
          ? undefined
          : // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Mimics the SDK's caller-typed verified request-state accessor.
            (requestState as T),
      ...(inputResponses === undefined ? {} : { inputResponses }),
    },
  };
}

async function captureContext(store: InMemoryEventStore): Promise<ServerContext> {
  let captured: ServerContext | undefined;
  const { client } = await connect(store, {
    captureContext: (requestContext) => {
      captured = requestContext;
    },
  });
  await client.callTool({ name: "test_capture_context", arguments: {} });
  if (captured === undefined) {
    throw new Error("test context was not captured");
  }
  return captured;
}

async function reviewRequest(input: {
  readonly store: InMemoryEventStore;
  readonly gate: ConfirmationGate;
  readonly requestId: Id;
  readonly context: ServerContext;
  readonly resolveInput: ResolveInputOperation;
}) {
  const found = await findPendingInput(input.store, input.requestId);
  if (found === undefined) {
    throw new Error("test input missing");
  }
  return reviewPendingInput({
    context: input.context,
    confirmationGate: input.gate,
    resolveInput: input.resolveInput,
    clientCapabilities: () => ({ elicitation: { form: {} } }),
    principal: undefined,
    runId: found.runId,
    request: found.request,
  });
}

const requestStateSchema = z.object({
  resultType: z.literal("input_required"),
  requestState: z.string(),
});

async function expectInputPending(store: InMemoryEventStore, runId: Id, requestId: Id) {
  await expect(listInputRequests(store, 10, [runId])).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId })]),
  );
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

  it("rejects tampered and expired review_input request state without resolving", async () => {
    let now = 100_000;
    for (const invalidState of ["tampered", "expired"] as const) {
      const store = new InMemoryEventStore();
      const { runId, requestId } = await createPendingInput(store);
      const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
      const gate = new ConfirmationGate({
        key: Buffer.alloc(32, 19),
        store,
        now: () => now,
      });
      const baseContext = await captureContext(store);
      const initial = await reviewRequest({
        store,
        gate,
        requestId,
        context: context(baseContext),
        resolveInput,
      });
      const state = requestStateSchema.parse(initial).requestState;
      if (invalidState === "expired") {
        now += 301_000;
      }

      let outcome: string;
      if (invalidState === "tampered") {
        outcome = await gate
          .verifyRequestState(`${state}x`, context(baseContext))
          .then(() => "verified", () => "invalid");
      } else {
        const verifiedState = await gate.verifyRequestState(state, context(baseContext));
        const result = await reviewRequest({
          store,
          gate,
          requestId,
          context: context(baseContext, verifiedState, {
            answer: { action: "accept", content: { name: "Ada" } },
          }),
          resolveInput,
        });
        outcome = z
          .object({ structuredContent: z.object({ code: z.string() }) })
          .parse(result).structuredContent.code;
      }

      expect(outcome).toBe(
        invalidState === "tampered" ? "invalid" : "confirmation_state_mismatch",
      );
      expect(resolveInput).not.toHaveBeenCalled();
      await expectInputPending(store, runId, requestId);
    }
  });

  it("rejects a request state presented by another client token", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const gate = new ConfirmationGate({ key: Buffer.alloc(32, 19), store });
    const firstContext = await captureContext(store);
    const initial = await reviewRequest({
      store,
      gate,
      requestId,
      context: context(firstContext),
      resolveInput,
    });
    const state = requestStateSchema.parse(initial).requestState;
    const secondContext = await captureContext(store);

    await expect(
      gate.verifyRequestState(state, context(secondContext, undefined, undefined, "another-token")),
    ).rejects.toBeDefined();

    expect(resolveInput).not.toHaveBeenCalled();
    await expectInputPending(store, runId, requestId);
  });

  it("rejects replayed and cross-input review_input state without a second resolution", async () => {
    const store = new InMemoryEventStore();
    const inputA = await createPendingInput(
      store,
      "form",
      Id.parse("A".repeat(26)),
      Id.parse("C".repeat(26)),
    );
    const inputB = await createPendingInput(
      store,
      "form",
      Id.parse("D".repeat(26)),
      Id.parse("E".repeat(26)),
    );
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const gate = new ConfirmationGate({ key: Buffer.alloc(32, 19), store });
    const baseContext = await captureContext(store);
    const initial = await reviewRequest({
      store,
      gate,
      requestId: inputA.requestId,
      context: context(baseContext),
      resolveInput,
    });
    const state = requestStateSchema.parse(initial).requestState;
    const verifiedState = await gate.verifyRequestState(state, context(baseContext));
    const accepted = await reviewRequest({
      store,
      gate,
      requestId: inputA.requestId,
      context: context(baseContext, verifiedState, {
        answer: { action: "accept", content: { name: "Ada" } },
      }),
      resolveInput,
    });
    expect(accepted.structuredContent).toEqual({ resolved: true });

    const replayState = await gate.verifyRequestState(state, context(baseContext));
    const replay = await reviewRequest({
      store,
      gate,
      requestId: inputA.requestId,
      context: context(baseContext, replayState, {
        answer: { action: "accept", content: { name: "Ada" } },
      }),
      resolveInput,
    });
    expect(replay.structuredContent).toMatchObject({
      resolved: false,
      code: "confirmation_state_replayed",
    });
    expect(resolveInput).toHaveBeenCalledOnce();
    await expectInputPending(store, inputA.runId, inputA.requestId);

    const stateForAResponse = await reviewRequest({
      store,
      gate,
      requestId: inputA.requestId,
      context: context(baseContext),
      resolveInput,
    });
    const stateForA = requestStateSchema.parse(stateForAResponse).requestState;
    const crossInputState = await gate.verifyRequestState(stateForA, context(baseContext));
    const crossInput = await reviewRequest({
      store,
      gate,
      requestId: inputB.requestId,
      context: context(baseContext, crossInputState, {
        answer: { action: "accept", content: { name: "Ada" } },
      }),
      resolveInput,
    });
    expect(crossInput.structuredContent).toMatchObject({
      resolved: false,
      code: "confirmation_state_mismatch",
    });
    expect(resolveInput).toHaveBeenCalledOnce();
    await expectInputPending(store, inputB.runId, inputB.requestId);
  });

  it("rejects an invalid form answer without resolving the pending input", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const gate = new ConfirmationGate({ key: Buffer.alloc(32, 19), store });
    const baseContext = await captureContext(store);
    const initial = await reviewRequest({
      store,
      gate,
      requestId,
      context: context(baseContext),
      resolveInput,
    });
    const state = requestStateSchema.parse(initial).requestState;
    const verifiedState = await gate.verifyRequestState(state, context(baseContext));
    const result = await reviewRequest({
      store,
      gate,
      requestId,
      context: context(baseContext, verifiedState, {
        answer: { action: "accept", content: { name: 42 } },
      }),
      resolveInput,
    });

    expect(result.structuredContent).toMatchObject({
      resolved: false,
      code: "human_input_invalid",
    });
    expect(resolveInput).not.toHaveBeenCalled();
    await expectInputPending(store, runId, requestId);
  });

  it("records declined reviews and sanitizes resolution failures", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store);
    const gate = new ConfirmationGate({ key: Buffer.alloc(32, 19), store });
    const baseContext = await captureContext(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);
    const initial = await reviewRequest({
      store,
      gate,
      requestId,
      context: context(baseContext),
      resolveInput,
    });
    const state = requestStateSchema.parse(initial).requestState;
    const verifiedState = await gate.verifyRequestState(state, context(baseContext));
    const declined = await reviewRequest({
      store,
      gate,
      requestId,
      context: context(baseContext, verifiedState, { answer: { action: "decline" } }),
      resolveInput,
    });

    expect(declined.structuredContent).toEqual({ resolved: true });
    expect(resolveInput).toHaveBeenCalledWith({
      runId,
      requestId,
      action: "decline",
      principal: "cli.control_plane",
    });

    const errorStore = new InMemoryEventStore();
    const errorInput = await createPendingInput(errorStore);
    const errorGate = new ConfirmationGate({ key: Buffer.alloc(32, 19), store: errorStore });
    const errorContext = await captureContext(errorStore);
    const failedResolve = vi.fn<ResolveInputOperation>().mockRejectedValue({
      code: "input_resolution_failed",
    });
    const errorInitial = await reviewRequest({
      store: errorStore,
      gate: errorGate,
      requestId: errorInput.requestId,
      context: context(errorContext),
      resolveInput: failedResolve,
    });
    const errorState = requestStateSchema.parse(errorInitial).requestState;
    const errorVerified = await errorGate.verifyRequestState(errorState, context(errorContext));
    const failed = await reviewRequest({
      store: errorStore,
      gate: errorGate,
      requestId: errorInput.requestId,
      context: context(errorContext, errorVerified, {
        answer: { action: "accept", content: { name: "Ada" } },
      }),
      resolveInput: failedResolve,
    });

    expect(failed.structuredContent).toMatchObject({
      resolved: false,
      code: "input_resolution_failed",
    });
    expect(failedResolve).toHaveBeenCalledOnce();
    await expectInputPending(errorStore, errorInput.runId, errorInput.requestId);
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

  it("fails closed for unavailable, missing, resolved, and failed app answers", async () => {
    const store = new InMemoryEventStore();
    const { runId, requestId } = await createPendingInput(store);
    const resolveInput = vi.fn<ResolveInputOperation>().mockResolvedValue(undefined);

    const nonApp = await connect(store, { resolveInput });
    const nonAppResult = await nonApp.client.callTool({
      name: "answer_input",
      arguments: { requestId, action: "accept", answer: { name: "Ada" } },
    });
    expect(nonAppResult.structuredContent).toMatchObject({
      resolved: false,
      code: "human_confirmation_unavailable",
    });

    const noRuntime = await connect(store, { isAppContext: true });
    const noRuntimeResult = await noRuntime.client.callTool({
      name: "answer_input",
      arguments: { requestId, action: "accept", answer: { name: "Ada" } },
    });
    expect(noRuntimeResult.structuredContent).toMatchObject({
      resolved: false,
      code: "control_plane_runtime_unavailable",
    });

    const app = await connect(store, { isAppContext: true, resolveInput });
    const missingResult = await app.client.callTool({
      name: "answer_input",
      arguments: {
        requestId: Id.parse("F".repeat(26)),
        action: "accept",
        answer: { name: "Ada" },
      },
    });
    expect(missingResult.structuredContent).toMatchObject({
      resolved: false,
      code: "input_not_found",
    });

    await resolveSeededInput(store, runId, requestId);
    const resolvedResult = await app.client.callTool({
      name: "answer_input",
      arguments: { requestId, action: "accept", answer: { name: "Ada" } },
    });
    expect(resolvedResult.structuredContent).toMatchObject({
      resolved: false,
      code: "input_already_resolved",
    });

    const pendingStore = new InMemoryEventStore();
    const pendingInput = await createPendingInput(pendingStore);
    const failure = await connect(pendingStore, {
      isAppContext: true,
      resolveInput: vi.fn<ResolveInputOperation>().mockRejectedValue("failure"),
    });
    const failureResult = await failure.client.callTool({
      name: "answer_input",
      arguments: {
        requestId: pendingInput.requestId,
        action: "accept",
        answer: { name: "Ada" },
      },
    });
    expect(failureResult.structuredContent).toMatchObject({
      resolved: false,
      code: "input_resolution_failed",
    });
  });
});
