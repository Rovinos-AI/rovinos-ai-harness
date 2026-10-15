// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  InMemoryTransport,
  type Client as McpClient,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Code, type Id, type NewEvent } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { AuditingVaultResolver, Token } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationGate } from "../confirmation-gate.js";
import { registerApprovalAppTools } from "./approvals-app.js";

const PRIVATE_CANARY = "private-canary@example.test";
const TOKEN = Token.parse("<EMAIL_1>");
interface Connection {
  readonly client: McpClient;
  readonly server: McpServer;
  readonly store: InMemoryEventStore;
}

const connections: Connection[] = [];

async function createApproval(
  store: InMemoryEventStore,
  options: { readonly resolved?: boolean; readonly editable?: boolean } = {},
): Promise<{ readonly runId: Id; readonly approvalId: Id }> {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const callId = builders.nextRunId();
  const approvalId = builders.nextRunId();
  const args = { name: "original", email: TOKEN };
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
      toolId: "tool.synthetic",
      idempotent: false,
      policyDecision: "ask",
      ruleId: "approval.synthetic",
      argsHash: "c".repeat(64),
      args,
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
        args,
        ruleId: "approval.synthetic",
        reason: "policy.ask",
        summary: "Review this request.",
        ui: {
          resourceUri: "ui://harness/approval/v1",
          fallbackText: "Review the tokenized approval.",
        },
        editableFields: options.editable === true ? ["/name"] : [],
      },
    },
    builders.runStatusChanged(runId, "running", "suspended"),
  ];
  await store.append(runId, events, 0);
  if (options.resolved === true) {
    await store.append(
      runId,
      [
        {
          runId,
          ts: 5,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: runId,
          type: "approval_resolved",
          approvalId,
          decision: "approve",
          decidedBy: "human",
          waitMs: 1,
        },
      ],
      events.length,
    );
  }
  return { runId, approvalId };
}

async function connect(
  options: {
    readonly allowReveal?: boolean;
    readonly requireRevealElicitation?: boolean;
    readonly authorize?: Parameters<typeof registerApprovalAppTools>[1]["authorize"];
    readonly resolver?: AuditingVaultResolver;
    readonly onAudit?: Parameters<typeof registerApprovalAppTools>[1]["onAudit"];
    readonly isAppContext?: boolean;
    readonly hasElicitation?: boolean;
    readonly now?: () => number;
    readonly resolveApproval?: Parameters<
      typeof registerApprovalAppTools
    >[1]["resolveApproval"];
  } = {},
): Promise<Connection> {
  const store = new InMemoryEventStore();
  const confirmationGate = new ConfirmationGate({
    store,
    key: Buffer.alloc(32, 19),
    isAppContext: () => options.isAppContext === true,
  });
  const server = new McpServer(
    { name: "approval-tools-test", version: "1.0.0" },
    { requestState: { verify: confirmationGate.verifyRequestState } },
  );
  registerApprovalAppTools(server, {
    store,
    confirmationGate,
    clientCapabilities: () =>
      options.hasElicitation === true ? { elicitation: { form: {} } } : undefined,
    authorize: options.authorize ?? (() => ({ allowed: true, tokenId: Code.parse("token.test") })),
    ...(options.allowReveal === undefined ? {} : { allowReveal: options.allowReveal }),
    ...(options.requireRevealElicitation === undefined
      ? {}
      : { requireRevealElicitation: options.requireRevealElicitation }),
    ...(options.resolver === undefined ? {} : { vaultResolver: options.resolver }),
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.resolveApproval === undefined
      ? {}
      : { resolveApproval: options.resolveApproval }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "approval-tools-client", version: "1.0.0" },
    options.hasElicitation === true ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (options.hasElicitation === true) {
    client.setRequestHandler("elicitation/create", () => ({
      action: "accept",
      content: { confirm: true },
    }));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = { client, server, store };
  connections.push(connection);
  return connection;
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

describe("app-only approval tools", () => {
  it("resolves an allowed edit through the runtime operation", async () => {
    const resolveApproval = vi.fn(() => Promise.resolve(undefined));
    const { store, client } = await connect({
      isAppContext: true,
      resolveApproval,
    });
    const approval = await createApproval(store, { editable: true });

    const result = await client.callTool({
      name: "harness.approvals.resolve",
      arguments: {
        approvalId: approval.approvalId,
        decision: "edit",
        edits: [{ pointer: "/name", value: "changed" }],
      },
    });

    expect(result.structuredContent).toEqual({ ok: true });
    expect(resolveApproval).toHaveBeenCalledWith({
      runId: approval.runId,
      approvalId: approval.approvalId,
      decision: "edit",
      edits: { name: "changed", email: TOKEN },
    });
  });

  it("returns metadata-only failure codes for unknown, resolved, and inaccessible approvals", async () => {
    const resolveApproval = vi.fn(() => Promise.resolve(undefined));
    const authorized = await connect({
      isAppContext: true,
      resolveApproval,
    });
    const resolved = await createApproval(authorized.store, { resolved: true });

    const missing = await authorized.client.callTool({
      name: "harness.approvals.resolve",
      arguments: { approvalId: "00000000000000000000000000", decision: "approve" },
    });
    const alreadyResolved = await authorized.client.callTool({
      name: "harness.approvals.resolve",
      arguments: { approvalId: resolved.approvalId, decision: "approve" },
    });
    const denied = await connect({
      isAppContext: true,
      authorize: (_context, scope) => ({
        allowed: scope !== "approve",
        tokenId: Code.parse("token.test"),
      }),
      resolveApproval,
    });
    const inaccessible = await createApproval(denied.store);
    const wrongRun = await denied.client.callTool({
      name: "harness.approvals.resolve",
      arguments: { approvalId: inaccessible.approvalId, decision: "approve" },
    });

    expect(missing.structuredContent).toEqual({ ok: false, code: "approval_not_found" });
    expect(alreadyResolved.structuredContent).toEqual({
      ok: false,
      code: "approval_already_resolved",
    });
    expect(wrongRun.structuredContent).toEqual({ ok: false, code: "approval_not_found" });
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(JSON.stringify([missing, alreadyResolved, wrongRun])).not.toContain(PRIVATE_CANARY);
  });

  it("refuses edits that are outside the stored editable field list", async () => {
    const resolveApproval = vi.fn(() => Promise.resolve(undefined));
    const { store, client } = await connect({ isAppContext: true, resolveApproval });
    const approval = await createApproval(store);

    const result = await client.callTool({
      name: "harness.approvals.resolve",
      arguments: {
        approvalId: approval.approvalId,
        decision: "edit",
        edits: [{ pointer: "/name", value: "changed" }],
      },
    });

    expect(result.structuredContent).toEqual({ ok: false, code: "edit_not_allowed" });
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("keeps reveal disabled by default and requires reveal scope when enabled", async () => {
    const resolver = new AuditingVaultResolver(
      { resolve: () => Promise.resolve(PRIVATE_CANARY) },
      () => undefined,
    );
    const disabled = await connect({ isAppContext: true, resolver });
    const approval = await createApproval(disabled.store);
    const disabledResult = await disabled.client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: approval.approvalId, pointers: ["/email"] },
    });
    const denied = await connect({
      isAppContext: true,
      allowReveal: true,
      resolver,
      authorize: (_context, scope) => ({
        allowed: scope !== "reveal",
        tokenId: Code.parse("token.test"),
      }),
    });
    const deniedApproval = await createApproval(denied.store);
    const deniedResult = await denied.client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: deniedApproval.approvalId, pointers: ["/email"] },
    });

    expect(disabledResult.structuredContent).toEqual({ values: [] });
    expect(disabledResult.content).toEqual([{ type: "text", text: "reveal_disabled" }]);
    expect(deniedResult.structuredContent).toEqual({ values: [] });
    expect(deniedResult.content).toEqual([{ type: "text", text: "approval_not_found" }]);
  });

  it("validates pointers against stored tokenized args and audits only metadata", async () => {
    const audits: unknown[] = [];
    const resolve = vi.fn((_runId, _token, context) => {
      expect(context).toEqual({ boundary: "ui" });
      return Promise.resolve(PRIVATE_CANARY);
    });
    const resolver = new AuditingVaultResolver({ resolve }, () => undefined);
    const { store, client } = await connect({
      allowReveal: true,
      isAppContext: true,
      requireRevealElicitation: false,
      resolver,
      onAudit: (audit) => audits.push(audit),
    });
    const approval = await createApproval(store);

    const invalid = await client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: approval.approvalId, pointers: ["/outside"] },
    });
    const result = await client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: approval.approvalId, pointers: ["/email"] },
    });

    expect(invalid.content).toEqual([{ type: "text", text: "pointer_invalid" }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      values: [{ pointer: "/email", value: PRIVATE_CANARY }],
    });
    expect(JSON.stringify(audits)).not.toContain(PRIVATE_CANARY);
    expect(audits).toContainEqual({
      tokenId: "token.test",
      tool: "harness.approvals.reveal",
      outcome: "ok",
      count: 1,
    });
  });

  it("requires elicitation when configured and enforces five reveals per session", async () => {
    const resolve = vi.fn(() => Promise.resolve(PRIVATE_CANARY));
    const resolver = new AuditingVaultResolver({ resolve }, () => undefined);
    const elicitation = await connect({
      allowReveal: true,
      hasElicitation: true,
      resolver,
      isAppContext: false,
    });
    const approval = await createApproval(elicitation.store);
    const confirmed = await elicitation.client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: approval.approvalId, pointers: ["/email"] },
    });

    expect(confirmed.structuredContent).toEqual({
      values: [{ pointer: "/email", value: PRIVATE_CANARY }],
    });

    const rateLimited = await connect({
      allowReveal: true,
      isAppContext: true,
      requireRevealElicitation: false,
      resolver,
      now: () => 10_000,
    });
    const rateLimitedApproval = await createApproval(rateLimited.store);
    for (let index = 0; index < 5; index += 1) {
      await rateLimited.client.callTool({
        name: "harness.approvals.reveal",
        arguments: { approvalId: rateLimitedApproval.approvalId, pointers: ["/email"] },
      });
    }
    const sixth = await rateLimited.client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: rateLimitedApproval.approvalId, pointers: ["/email"] },
    });

    expect(sixth.content).toEqual([{ type: "text", text: "rate_limited" }]);
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it("rejects a reveal without elicitation support when confirmation is required", async () => {
    const resolve = vi.fn(() => Promise.resolve(PRIVATE_CANARY));
    const resolver = new AuditingVaultResolver({ resolve }, () => undefined);
    const { store, client } = await connect({
      allowReveal: true,
      isAppContext: false,
      resolver,
    });
    const approval = await createApproval(store);

    const result = await client.callTool({
      name: "harness.approvals.reveal",
      arguments: { approvalId: approval.approvalId, pointers: ["/email"] },
    });

    expect(result.structuredContent).toEqual({
      values: [],
    });
    expect(result.content).toEqual([{ type: "text", text: "human_confirmation_unavailable" }]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
