// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Id,
  PiiPolicySchema,
  type Detection,
  type Event,
  type InputRequest,
  type NewEvent,
} from "@rovinos/schemas";
import { InMemoryEventStore, RunQueueJobSchema, SeqConflictError } from "@rovinos/store";
import { AuditingVaultResolver, InMemoryVault } from "@rovinos/vault";
import { Tokenizer } from "@rovinos/pii";
import { describe, expect, it, vi } from "vitest";
import {
  resolveInput,
  expireInput,
  InputAnswerInvalidError,
  InputNotExpiredError,
} from "./resolve.js";

const runId = Id.parse("A".repeat(26));
const callId = Id.parse("B".repeat(26));
const requestId = Id.parse("C".repeat(26));
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const segmentId = runId;
const email = "answer-canary@example.test";
const form = {
  type: "object" as const,
  properties: {
    email: { type: "string" as const, format: "email" as const },
  },
  required: ["email"],
};

class ConflictingEventStore extends InMemoryEventStore {
  conflictWrites = false;
  cancelOnConflict = false;

  override async append(
    eventRunId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    if (!this.conflictWrites) {
      return super.append(eventRunId, events, expectedSeq, leaseOwner);
    }
    if (!this.cancelOnConflict) {
      throw new SeqConflictError(expectedSeq, expectedSeq + 1);
    }
    this.conflictWrites = false;
    await super.append(
      eventRunId,
      [
        {
          type: "run_status_changed",
          v: 1,
          runId: eventRunId,
          ts: 200,
          traceId,
          spanId,
          segmentId,
          from: "suspended",
          to: "cancelled",
          reason: "cancelled",
        },
      ],
      expectedSeq,
    );
    throw new SeqConflictError(expectedSeq, expectedSeq + 1);
  }
}

function tokenizer(policy = PiiPolicySchema.parse({})): Tokenizer {
  const detect = (text: string): readonly Detection[] => {
    const start = text.indexOf(email);
    return start < 0
      ? []
      : [
          {
            entityType: "email",
            start,
            end: start + email.length,
            confidence: 1,
            detectorId: "test.email",
          },
        ];
  };
  return new Tokenizer({
    detectors: { detect },
    policy,
    vault: new InMemoryVault(),
  });
}

function schemaResolver(): AuditingVaultResolver {
  return new AuditingVaultResolver(
    { resolve: (_runId, token) => Promise.resolve(token === "<EMAIL_1>" ? email : undefined) },
    () => undefined,
  );
}

async function makePendingInput(
  options: {
    readonly source?: "mcp_mrtr" | "mcp_legacy" | "agent";
    readonly mode?: "form" | "url";
    readonly expiresAt?: number;
    readonly separationOfDuties?: boolean;
    readonly requestedBy?: string;
    readonly withoutToolIntent?: boolean;
    readonly schema?: InputRequest["schema"];
  } = {},
  store = new InMemoryEventStore(),
): Promise<InMemoryEventStore> {
  const source = options.source ?? "mcp_mrtr";
  const mode = options.mode ?? "form";
  const events: NewEvent[] = [
    {
      type: "run_created",
      v: 1,
      runId,
      ts: 100,
      traceId,
      spanId,
      segmentId,
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
      ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
      depth: 0,
    },
    {
      type: "run_status_changed",
      v: 1,
      runId,
      ts: 101,
      traceId,
      spanId,
      segmentId,
      from: "pending",
      to: "running",
      reason: "started",
    },
    {
      type: "tool_intent",
      v: 1,
      runId,
      ts: 102,
      traceId,
      spanId,
      segmentId,
      callId,
      toolId: "mcp.echo",
      idempotent: true,
      policyDecision: "allow",
      ...(options.separationOfDuties === true ? { policySeparationOfDuties: true } : {}),
      argsHash: "a".repeat(64),
      args: {},
    },
    {
      type: "input_requested",
      v: 1,
      runId,
      ts: 103,
      traceId,
      spanId,
      segmentId,
      requestId,
      source,
      ...(source === "mcp_mrtr" || source === "mcp_legacy" ? { serverId: "mcp.server" } : {}),
      ...(source === "mcp_legacy" ? {} : { callId }),
      ...(source === "mcp_mrtr" ? { inputKey: "account" } : {}),
      round: 1,
      mode,
      ...(mode === "form"
        ? { schema: options.schema ?? form, message: "Contact <EMAIL_1>" }
        : { url: "https://example.test", message: "Confirm <EMAIL_1>" }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
    {
      type: "run_status_changed",
      v: 1,
      runId,
      ts: 104,
      traceId,
      spanId,
      segmentId,
      from: "running",
      to: "suspended",
      reason: "awaiting_input",
    },
  ];
  await store.append(
    runId,
    options.withoutToolIntent === true
      ? events.filter((event) => event.type !== "tool_intent")
      : events,
    0,
  );
  return store;
}

async function readEvents(store: InMemoryEventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function resumeQueue(
  enqueue = vi.fn(() =>
    Promise.resolve(
      RunQueueJobSchema.parse({
        jobId: "D".repeat(26),
        kind: "resume",
        runId,
        priority: 0,
        availableAt: 0,
        attempts: 0,
        maxAttempts: 5,
        createdAt: 0,
        updatedAt: 0,
      }),
    ),
  ),
) {
  return { enqueue };
}

describe("resolveInput", () => {
  it("resolves a pending request from another process and never records the raw answer", async () => {
    const store = await makePendingInput();
    const resolution = await resolveInput(store, runId, requestId, {
      action: "accept",
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      clock: { now: () => 500 },
    });

    expect(resolution).toMatchObject({
      type: "input_resolved",
      action: "accept",
      approverId: "cli.human",
      waitMs: 397,
      answer: { email: "<EMAIL_1>" },
    });
    expect(JSON.stringify(await readEvents(store))).not.toContain(email);
  });

  it("rejects invalid answers without recording them", async () => {
    const store = await makePendingInput();

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: {},
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toBeInstanceOf(InputAnswerInvalidError);
    expect((await readEvents(store)).some((event) => event.type === "input_resolved")).toBe(false);
  });

  it("validates tokenized defaults and enums against their protected original values", async () => {
    const store = await makePendingInput({
      schema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            format: "email",
            enum: ["<EMAIL_1>"],
            default: "<EMAIL_1>",
          },
        },
      },
    });

    const resolution = await resolveInput(store, runId, requestId, {
      action: "accept",
      answer: {},
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      resolver: schemaResolver(),
      clock: { now: () => 500 },
    });

    expect(resolution.answer).toEqual({ email: "<EMAIL_1>" });
    expect(JSON.stringify(await readEvents(store))).not.toContain(email);
  });

  it("rejects an invalid human principal", async () => {
    const store = await makePendingInput();

    await expect(
      resolveInput(store, runId, requestId, {
        action: "decline",
        principal: Code.parse("system.other"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toMatchObject({ code: "input_principal_invalid" });
  });

  it("rejects unknown requests", async () => {
    const store = new InMemoryEventStore();

    await expect(
      resolveInput(store, runId, requestId, {
        action: "cancel",
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toMatchObject({ code: "input_not_found" });
  });

  it("rejects a double resolution", async () => {
    const store = await makePendingInput();
    const resolution = {
      action: "accept" as const,
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      clock: { now: () => 500 },
    };
    await resolveInput(store, runId, requestId, resolution);

    await expect(resolveInput(store, runId, requestId, resolution)).rejects.toMatchObject({
      code: "input_already_resolved",
    });
  });

  it("enqueues a resume after recording the answer", async () => {
    const store = await makePendingInput();
    const queue = {
      enqueue: vi.fn(() =>
        Promise.resolve(
          RunQueueJobSchema.parse({
            jobId: "D".repeat(26),
            kind: "resume",
            runId,
            priority: 0,
            availableAt: 0,
            attempts: 0,
            maxAttempts: 5,
            createdAt: 0,
            updatedAt: 0,
          }),
        ),
      ),
    };

    await resolveInput(store, runId, requestId, {
      action: "accept",
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      queue,
      clock: { now: () => 500 },
    });

    expect(queue.enqueue).toHaveBeenCalledWith({ kind: "resume", runId });
  });

  it("enforces separation of duties for configured tool calls", async () => {
    const store = await makePendingInput({
      separationOfDuties: true,
      requestedBy: "cli.requester",
    });

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.requester"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toMatchObject({ code: "approver_is_requester" });
  });

  it("tokenizes an answer even when tool_input policy allows it raw", async () => {
    const store = await makePendingInput();
    const piiTokenizer = tokenizer(
      PiiPolicySchema.parse({
        rules: [
          {
            entities: ["email"],
            boundaries: ["tool_input"],
            destinations: [{ tool: "mcp.echo" }],
            action: "allow",
          },
        ],
      }),
    );

    const resolution = await resolveInput(store, runId, requestId, {
      action: "accept",
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: piiTokenizer,
      clock: { now: () => 500 },
    });

    expect(resolution.answer).toEqual({ email: "<EMAIL_1>" });
    expect(JSON.stringify(await readEvents(store))).not.toContain(email);
  });

  it("rejects an MCP answer with no pending tool destination", async () => {
    const store = await makePendingInput({ source: "mcp_legacy", withoutToolIntent: true });

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toMatchObject({ code: "input_destination_unavailable" });
    expect((await readEvents(store)).some((event) => event.type === "input_resolved")).toBe(false);
  });

  it("records a late absolute-deadline answer as expiry and rejects it", async () => {
    const store = await makePendingInput({ expiresAt: 200 });

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 200 },
      }),
    ).rejects.toMatchObject({ code: "input_expired" });

    expect((await readEvents(store)).at(-1)).toMatchObject({
      type: "input_resolved",
      action: "cancel",
      decidedBy: "expiry",
    });
    expect(JSON.stringify(await readEvents(store))).not.toContain(email);
  });

  it("uses the configured age deadline when rejecting a late answer", async () => {
    const store = await makePendingInput({ source: "agent" });

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 1_103 },
        expiresAfterMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "input_expired" });

    expect((await readEvents(store)).at(-1)).toMatchObject({
      type: "input_resolved",
      action: "cancel",
      decidedBy: "expiry",
    });
  });

  it("resolves URL consent without an answer", async () => {
    const store = await makePendingInput({ mode: "url" });

    const resolution = await resolveInput(store, runId, requestId, {
      action: "accept",
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      clock: { now: () => 500 },
    });

    expect(resolution).toMatchObject({ action: "accept" });
    expect(resolution).not.toHaveProperty("answer");
  });

  it("rejects an expired request until its deadline has passed", async () => {
    const store = await makePendingInput({ expiresAt: 600 });

    await expect(
      expireInput(store, runId, requestId, {
        tokenizer: tokenizer(),
        clock: { now: () => 599 },
        expiresAfterMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(InputNotExpiredError);
  });

  it("records expired requests as cancelled by expiry", async () => {
    const store = await makePendingInput({ expiresAt: 600 });

    const resolution = await expireInput(store, runId, requestId, {
      tokenizer: tokenizer(),
      clock: { now: () => 600 },
      expiresAfterMs: 1_000,
    });

    expect(resolution).toMatchObject({
      action: "cancel",
      decidedBy: "expiry",
      waitMs: 497,
    });
    expect(resolution).not.toHaveProperty("approverId");
  });

  it("uses the configured age when a request has no absolute expiry", async () => {
    const store = await makePendingInput({ source: "agent" });

    const resolution = await expireInput(store, runId, requestId, {
      tokenizer: tokenizer(),
      clock: { now: () => 1_103 },
      expiresAfterMs: 1_000,
    });

    expect(resolution.decidedBy).toBe("expiry");
  });

  it("uses the any destination for agent answers", async () => {
    const store = await makePendingInput({ source: "agent" });
    const piiTokenizer = tokenizer();
    const tokenizeJson = vi.spyOn(piiTokenizer, "tokenizeJson");

    await resolveInput(store, runId, requestId, {
      action: "accept",
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: piiTokenizer,
      clock: { now: () => 500 },
    });

    expect(tokenizeJson).toHaveBeenCalledWith(
      runId,
      { email },
      { boundary: "tool_input", destination: "any", allowRaw: false },
    );
  });

  it("rejects resolutions after cancellation", async () => {
    const store = await makePendingInput();
    const events = await readEvents(store);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected pending input events.");
    }
    await store.append(
      runId,
      [
        {
          type: "run_status_changed",
          v: 1,
          runId,
          ts: 200,
          traceId,
          spanId,
          segmentId,
          from: "suspended",
          to: "cancelled",
          reason: "cancelled",
        },
      ],
      events.length,
    );

    await expect(
      resolveInput(store, runId, requestId, {
        action: "accept",
        answer: { email },
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
      }),
    ).rejects.toMatchObject({ code: "input_run_terminal" });
    expect((await readEvents(store)).some((event) => event.type === "input_resolved")).toBe(false);
  });

  it("re-reads terminal state after a sequence conflict", async () => {
    const store = new ConflictingEventStore();
    await makePendingInput({}, store);
    store.conflictWrites = true;
    store.cancelOnConflict = true;

    await expect(
      resolveInput(store, runId, requestId, {
        action: "decline",
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
      }),
    ).rejects.toMatchObject({ code: "input_run_terminal" });
  });

  it("recovers a failed resume enqueue on a resolved-input retry", async () => {
    const store = await makePendingInput();
    const queue = resumeQueue();
    queue.enqueue.mockRejectedValueOnce(new Error("Synthetic queue failure."));
    const resolution = {
      action: "accept" as const,
      answer: { email },
      principal: Code.parse("cli.human"),
      tokenizer: tokenizer(),
      queue,
      clock: { now: () => 500 },
    };

    await expect(resolveInput(store, runId, requestId, resolution)).rejects.toThrow();
    await expect(resolveInput(store, runId, requestId, resolution)).rejects.toMatchObject({
      code: "input_already_resolved",
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("recovers a failed expiry resume enqueue on an expired-input retry", async () => {
    const store = await makePendingInput({ source: "agent" });
    const queue = resumeQueue();
    queue.enqueue.mockRejectedValueOnce(new Error("Synthetic queue failure."));
    const dependencies = {
      tokenizer: tokenizer(),
      queue,
      clock: { now: () => 1_103 },
      expiresAfterMs: 1_000,
    };

    await expect(expireInput(store, runId, requestId, dependencies)).rejects.toThrow();
    await expect(expireInput(store, runId, requestId, dependencies)).rejects.toMatchObject({
      code: "input_already_resolved",
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("stops after bounded sequence conflicts and re-reads the pending request", async () => {
    const store = new ConflictingEventStore();
    await makePendingInput({}, store);
    store.conflictWrites = true;

    await expect(
      resolveInput(store, runId, requestId, {
        action: "decline",
        principal: Code.parse("cli.human"),
        tokenizer: tokenizer(),
        clock: { now: () => 500 },
      }),
    ).rejects.toMatchObject({ code: "input_resolution_conflict" });
  });
});
