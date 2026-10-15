// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { EventStore } from "@harness/store";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { Code, JsonValue, type Id, type NewEvent } from "@harness/schemas";
import { ApprovalEditError } from "@harness/policy";
import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationGate, type ConfirmationRequest } from "./confirmation-gate.js";
import { createControlPlaneServer } from "./server.js";
import type { ResolveApprovalOperation } from "./tools/approve.js";
import { findApprovalRequest } from "./tools/run-state.js";

interface TestConnection {
  readonly client: Client;
  readonly server: ReturnType<typeof createControlPlaneServer>;
}

const connections: TestConnection[] = [];
const approvalCanary = "APPROVAL_CONTENT_CANARY";

async function connect(
  store: EventStore,
  options: Parameters<typeof createControlPlaneServer>[1] = {},
  response?: "accept" | "decline" | "cancel",
): Promise<TestConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createControlPlaneServer(store, {
    approvalHtml: "<html>test</html>",
    confirmation: { key: Buffer.alloc(32, 19) },
    ...options,
  });
  const client = new Client(
    { name: "control-plane-lifecycle-test", version: "1.0.0" },
    {
      capabilities: response === undefined ? {} : { elicitation: { form: {} } },
      versionNegotiation: { mode: "auto" },
    },
  );
  if (response !== undefined) {
    client.setRequestHandler("elicitation/create", () => ({
      action: response,
      ...(response === "accept" ? { content: { confirm: true } } : {}),
    }));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = { client, server };
  connections.push(connection);
  return connection;
}

async function addPendingApproval(
  store: EventStore,
  builders: ReturnType<typeof createEventBuilders>,
): Promise<{ readonly runId: Id; readonly approvalId: Id }> {
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
      args: { private: approvalCanary },
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
        toolId: "tool.synthetic",
        args: { private: approvalCanary },
        ruleId: "approval.synthetic",
        reason: "policy.ask",
        summary: `Approve ${approvalCanary}`,
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
  return { runId, approvalId };
}

function resolutionOperation(store: EventStore): ResolveApprovalOperation {
  return async ({ runId, approvalId, decision, edits, reason }) => {
    if (decision === "edit") {
      throw new ApprovalEditError("edit_invalid");
    }
    const event: NewEvent = {
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
      waitMs: 16,
      ...(reason === undefined ? {} : { reason }),
      ...(edits === undefined ? {} : { edits }),
    };
    await store.append(runId, [event], await store.head(runId));
  };
}

async function countResolutions(store: EventStore, runId: Id): Promise<number> {
  let resolutions = 0;
  for await (const event of store.read(runId)) {
    if (event.type === "approval_resolved") {
      resolutions += 1;
    }
  }
  return resolutions;
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
  vi.restoreAllMocks();
});

describe("confirmation-gated control-plane tools", () => {
  it("skips stale run summaries and stops when a pagination cursor repeats", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    await store.append(runId, [builders.runCreated(runId)], 0);
    const firstPage = await store.listRuns({ limit: 50 });
    const listRuns = vi
      .spyOn(store, "listRuns")
      .mockResolvedValueOnce({ ...firstPage, nextCursor: "stale-cursor" })
      .mockResolvedValueOnce({ ...firstPage, nextCursor: "stale-cursor" });
    const emptyEvents: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
    vi.spyOn(store, "read").mockReturnValue(emptyEvents);

    await expect(findApprovalRequest(store, builders.nextRunId())).resolves.toBeUndefined();

    expect(listRuns).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it("requires supported elicitation when no trusted app context is supplied", async () => {
    const store = new InMemoryEventStore();
    const { runId, approvalId } = await addPendingApproval(store, createEventBuilders());
    const resolveApproval = vi.fn(resolutionOperation(store));
    const { client } = await connect(store, { operations: { resolveApproval } });

    const result = await client.callTool({ name: "approve", arguments: { approvalId } });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "human_confirmation_unavailable" },
      content: [{ type: "text", text: "human_confirmation_unavailable" }],
    });
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(await countResolutions(store, runId)).toBe(0);
  });

  it("records accepted approve and deny decisions exactly once without exposing payload content", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const approved = await addPendingApproval(store, builders);
    const denied = await addPendingApproval(store, builders);
    const resolveApproval = vi.fn(resolutionOperation(store));
    const resumeRun = vi.fn(() => Promise.resolve(undefined));
    const { client } = await connect(
      store,
      { operations: { resolveApproval, resumeRun } },
      "accept",
    );

    const approveResult = await client.callTool({
      name: "approve",
      arguments: { approvalId: approved.approvalId },
    });
    const denyResult = await client.callTool({
      name: "deny",
      arguments: { approvalId: denied.approvalId, reason: "reviewed" },
    });

    expect(approveResult).toMatchObject({
      content: [{ type: "text", text: "Decision recorded." }],
    });
    expect(denyResult).toMatchObject({
      content: [{ type: "text", text: "Decision recorded." }],
    });
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    expect(resolveApproval).toHaveBeenNthCalledWith(1, {
      runId: approved.runId,
      approvalId: approved.approvalId,
      decision: "approve",
    });
    expect(resolveApproval).toHaveBeenNthCalledWith(2, {
      runId: denied.runId,
      approvalId: denied.approvalId,
      decision: "deny",
      reason: Code.parse("reviewed"),
    });
    const repeatedDeny = await client.callTool({
      name: "deny",
      arguments: { approvalId: denied.approvalId },
    });
    expect(repeatedDeny.structuredContent).toEqual({
      ok: false,
      code: "approval_already_resolved",
    });
    expect(await countResolutions(store, approved.runId)).toBe(1);
    expect(await countResolutions(store, denied.runId)).toBe(1);
    expect(`${JSON.stringify(approveResult)}${JSON.stringify(denyResult)}`).not.toContain(
      approvalCanary,
    );
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("returns safe denial errors for unavailable and failing resolution operations", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const unavailable = await addPendingApproval(store, builders);
    const failing = await addPendingApproval(store, builders);
    const resolveApproval = vi
      .fn<ResolveApprovalOperation>()
      .mockRejectedValueOnce({ code: Code.parse("resume_conflict") })
      .mockRejectedValueOnce(new Error(approvalCanary));
    const { client } = await connect(store, { isAppContext: () => true });
    const { client: failingClient } = await connect(store, {
      isAppContext: () => true,
      operations: { resolveApproval },
    });

    const unavailableResult = await client.callTool({
      name: "deny",
      arguments: { approvalId: unavailable.approvalId },
    });
    const knownError = await failingClient.callTool({
      name: "deny",
      arguments: { approvalId: failing.approvalId },
    });
    const unknownError = await failingClient.callTool({
      name: "deny",
      arguments: { approvalId: failing.approvalId },
    });

    expect(unavailableResult.structuredContent).toEqual({
      ok: false,
      code: "control_plane_runtime_unavailable",
    });
    expect(knownError.structuredContent).toEqual({ ok: false, code: "resume_conflict" });
    expect(unknownError.structuredContent).toEqual({
      ok: false,
      code: "approval_resolution_failed",
    });
    expect(`${JSON.stringify(knownError)}${JSON.stringify(unknownError)}`).not.toContain(
      approvalCanary,
    );
  });

  it.each(["decline", "cancel"] as const)(
    "does not resolve an approval when the human chooses %s",
    async (response) => {
      const store = new InMemoryEventStore();
      const builders = createEventBuilders();
      const { runId, approvalId } = await addPendingApproval(store, builders);
      const resolveApproval = vi.fn(resolutionOperation(store));
      const { client } = await connect(store, { operations: { resolveApproval } }, response);

      const result = await client.callTool({
        name: "deny",
        arguments: { approvalId },
      });

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "human_confirmation_declined" }],
      });
      expect(resolveApproval).not.toHaveBeenCalled();
      expect(await countResolutions(store, runId)).toBe(0);
    },
  );

  it("allows an app action only when the trusted host asserts app provenance", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const { runId, approvalId } = await addPendingApproval(store, builders);
    const resolveApproval = vi.fn(resolutionOperation(store));
    const { client } = await connect(store, {
      isAppContext: () => true,
      operations: { resolveApproval },
    });

    const result = await client.callTool({
      name: "approve",
      arguments: { approvalId },
    });

    expect(result.structuredContent).toEqual({ ok: true });
    expect(resolveApproval).toHaveBeenCalledOnce();
    expect(await countResolutions(store, runId)).toBe(1);
  });

  it("rejects invalid edits before recording an approval resolution", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const { runId, approvalId } = await addPendingApproval(store, builders);
    const resolveApproval = vi.fn(resolutionOperation(store));
    const { client } = await connect(store, {
      isAppContext: () => true,
      operations: { resolveApproval },
    });

    const result = await client.callTool({
      name: "approve",
      arguments: { approvalId, edits: JsonValue.parse({ changed: true }) },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "edit_invalid" },
    });
    expect(resolveApproval).toHaveBeenCalledOnce();
    expect(await countResolutions(store, runId)).toBe(0);
  });

  it("aborts a supervised resume before requesting durable cancellation", async () => {
    const store = new InMemoryEventStore();
    const runId = createEventBuilders().nextRunId();
    let resumeSignal: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operations = {
      resumeRun: vi.fn((_runId: Id, signal: AbortSignal, onClaimed: () => void) => {
        resumeSignal = signal;
        markStarted();
        onClaimed();
        return new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }),
      cancelRun: vi.fn(() => Promise.resolve("cancelled")),
    };
    const { client } = await connect(store, { isAppContext: () => true, operations });

    const resume = await client.callTool({ name: "resume_run", arguments: { runId } });
    expect(resume.structuredContent).toEqual({ started: true });
    await started;
    const cancelled = await client.callTool({ name: "cancel_run", arguments: { runId } });

    expect(cancelled.structuredContent).toEqual({ ok: true });
    expect(resumeSignal?.aborted).toBe(true);
    expect(operations.resumeRun).toHaveBeenCalledOnce();
    expect(operations.cancelRun).toHaveBeenCalledOnce();
  });

  it("persists single-use confirmation state across gate instances and canonicalizes arguments", async () => {
    const store = new InMemoryEventStore();
    const key = Buffer.alloc(32, 19);
    let capturedContext: ServerContext | undefined;
    const gate = new ConfirmationGate({
      store,
      key,
      isAppContext: (context) => {
        capturedContext = context;
        return false;
      },
    });
    const { client } = await connect(store, { confirmationGate: gate });
    const targetId = createEventBuilders().nextRunId();
    await client.callTool({ name: "resume_run", arguments: { runId: targetId } });
    if (capturedContext === undefined) {
      throw new Error("Expected an MCP request context.");
    }

    const request: ConfirmationRequest = {
      toolName: "test_decision",
      targetId,
      arguments: { first: "one", second: "two" },
      summary: "Confirm test decision?",
      clientCapabilities: { elicitation: { form: {} } },
    };
    const challenge = await gate.requireHuman(capturedContext, request);
    if (challenge.status !== "input_required") {
      throw new Error("Expected a confirmation challenge.");
    }
    const requestStateToken = challenge.result.requestState;
    if (requestStateToken === undefined) {
      throw new Error("Expected a confirmation request state.");
    }
    const retryContext: ServerContext = {
      ...capturedContext,
      mcpReq: {
        ...capturedContext.mcpReq,
        inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      },
    };
    const reorderedRequest = {
      ...request,
      arguments: { second: "two", first: "one" },
    };

    await expect(
      gate.requireHuman(retryContext, reorderedRequest, requestStateToken),
    ).resolves.toEqual({ status: "allowed" });
    await expect(
      new ConfirmationGate({ store, key }).requireHuman(
        retryContext,
        reorderedRequest,
        requestStateToken,
      ),
    ).resolves.toEqual({ status: "denied", code: "confirmation_state_replayed" });
  });

  it("returns safe cancellation outcomes for missing and failing runtime operations", async () => {
    const store = new InMemoryEventStore();
    const { client: unavailableClient } = await connect(store, { isAppContext: () => true });
    const cancelRun = vi
      .fn<(runId: Id) => Promise<unknown>>()
      .mockResolvedValueOnce("already_terminal")
      .mockRejectedValueOnce({ code: Code.parse("resume_conflict") })
      .mockRejectedValueOnce(new Error(approvalCanary));
    const { client } = await connect(store, {
      isAppContext: () => true,
      operations: { cancelRun },
    });

    const unavailable = await unavailableClient.callTool({
      name: "cancel_run",
      arguments: { runId: createEventBuilders().nextRunId() },
    });
    const alreadyTerminal = await client.callTool({
      name: "cancel_run",
      arguments: { runId: createEventBuilders().nextRunId() },
    });
    const knownError = await client.callTool({
      name: "cancel_run",
      arguments: { runId: createEventBuilders().nextRunId() },
    });
    const unknownError = await client.callTool({
      name: "cancel_run",
      arguments: { runId: createEventBuilders().nextRunId() },
    });

    expect(unavailable.structuredContent).toEqual({
      ok: false,
      code: "control_plane_runtime_unavailable",
    });
    expect(alreadyTerminal.structuredContent).toEqual({ ok: true, code: "already_terminal" });
    expect(knownError.structuredContent).toEqual({ ok: false, code: "resume_conflict" });
    expect(unknownError.structuredContent).toEqual({ ok: false, code: "cancel_failed" });
    expect(`${JSON.stringify(knownError)}${JSON.stringify(unknownError)}`).not.toContain(
      approvalCanary,
    );
  });
});
