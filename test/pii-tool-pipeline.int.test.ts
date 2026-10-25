// SPDX-License-Identifier: Apache-2.0
// Synthetic canaries exercise every persisted event and the workspace offload sink.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type Detection,
  JsonValue,
} from "@rovinos/schemas";
import {
  applyResolvedApprovals,
  createRuntime,
  foldRunState,
  resolveApproval,
  RunRecorder,
  RUN_SPAN,
  type ModelCompletion,
  type ToolPort,
} from "@rovinos/core";
import { FakeModelPort, allowAllPolicy } from "@rovinos/core/testing";
import { OffloadingToolPort, type WorkspacePort } from "@rovinos/context";
import { InMemoryEventStore } from "@rovinos/store";
import { AuditingVaultResolver, InMemoryVault } from "@rovinos/vault";
import { PiiToolPort, Tokenizer } from "@rovinos/pii";
import { buildApprovalPayload } from "@rovinos/policy";

const email = "pipeline-canary@example.test";
const card = "4111111111111111";
const callId = "00000000000000000000000010";

function completion(toolCall = false): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts: toolCall
      ? [{ type: "tool_call", callId, toolId: "mail.send", args: { to: email, note: email } }]
      : [{ type: "text", text: "done" }],
    providerBlobs: toolCall ? { duplicatedArgs: email } : null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: toolCall ? "tool_calls" : "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function detect(text: string): Detection[] {
  return [
    { value: email, entityType: "email" },
    { value: card, entityType: "credit_card" },
  ].flatMap(({ value, entityType }) => {
    const start = text.indexOf(value);
    return start < 0
      ? []
      : [
          {
            entityType,
            start,
            end: start + value.length,
            confidence: 1,
            detectorId: "test.synthetic",
          },
        ];
  });
}

async function pipeline(
  options: {
    readonly block?: boolean;
    readonly detectorFailure?: boolean;
    readonly vaultFailure?: boolean;
    readonly largeText?: boolean;
    readonly binary?: boolean;
    readonly output?: JsonValue;
  } = {},
) {
  const config = PiiConfigSchema.parse({
    defaultAction: options.block === true ? "block" : "tokenize",
    detokenize: [{ toolId: "mail.send", args: ["/to"] }],
  });
  const vault = new InMemoryVault();
  if (options.vaultFailure === true) {
    vi.spyOn(vault, "put").mockRejectedValue(new Error(email));
  }
  const execute = vi.fn<ToolPort["execute"]>(() =>
    Promise.resolve({
      outcome: "ok",
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      result:
        options.output ??
        (options.largeText === true
          ? "x".repeat(2 * 1024 * 1024)
          : { card, padding: "x".repeat(200) }),
    }),
  );
  const files = new Map<string, Uint8Array>();
  const workspace: WorkspacePort = {
    write: (path, data) => {
      files.set(path, data.slice());
      return Promise.resolve();
    },
    read: (path, range) =>
      Promise.resolve(
        (files.get(path) ?? new Uint8Array()).slice(
          range?.offset,
          range === undefined ? undefined : range.offset + range.length,
        ),
      ),
  };
  const ids = new SequentialIdGenerator();
  const model = new FakeModelPort([completion(true), completion()]);
  const tool = new OffloadingToolPort(
    new PiiToolPort(
      {
        describe: () => ({ idempotent: true, timeoutMs: 1000 }),
        execute,
      },
      {
        tokenizer: new Tokenizer({
          vault,
          policy: config,
          detectors: {
            detect: (text) => {
              if (options.detectorFailure === true) {
                throw Object.assign(new Error(email), { code: email });
              }
              return detect(text);
            },
          },
        }),
        config,
        resolver: new AuditingVaultResolver(vault, () => undefined),
      },
    ),
    workspace,
    { thresholdBytes: 100, previewChars: 100 },
    ids,
  );
  const store = new InMemoryEventStore();
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({ checkpointEveryEvents: 2 }),
      pii: PiiConfigSchema.parse({ enabled: false }),
    },
    {
      store,
      transientVault: true,
      clock: new FakeClock(100),
      ids,
      tool,
      model,
      policy: allowAllPolicy,
    },
  );
  try {
    const result = await runtime.run("synthetic tool pipeline");
    return { result, execute, files, store, model, tool };
  } finally {
    await runtime.close();
  }
}

describe("PII tool pipeline", () => {
  it("offloads oversized validated binary with an empty preview", async () => {
    const { result, files } = await pipeline({
      binary: true,
      output: Array.from({ length: 530000 }, () => 255),
    });
    expect(files.size).toBe(1);
    expect(result.events.find((event) => event.type === "tool_result")).toMatchObject({
      outcome: "ok",
      result: { $offloaded: { preview: "" } },
    });
    expect([...files.values()][0]?.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    for (const event of result.events) {
      expect(JSON.stringify(event)).not.toContain(email);
    }
  });

  it("denies falsely flagged textual binary before the offload sink", async () => {
    const { result, files } = await pipeline({ binary: true, output: email });
    expect(files.size).toBe(0);
    expect(result.events.find((event) => event.type === "tool_result")).toMatchObject({
      outcome: "error",
      errorCode: "pii_input_invalid",
      result: null,
    });
    expect(JSON.stringify(result.events)).not.toContain(email);
  });
  it("tokenizes before every event and offload file, resolving only the allowlist", async () => {
    const { result, execute, files, store } = await pipeline();
    expect(result.status).toBe("completed");
    expect(execute.mock.calls[0]?.[0].args).toEqual({ to: email, note: "<EMAIL_1>" });
    const intent = result.events.find((event) => event.type === "tool_intent");
    expect(intent?.args).toEqual({ to: "<EMAIL_1>", note: "<EMAIL_1>" });
    expect(result.events.filter((event) => event.type === "pii_action")).toMatchObject([
      { boundary: "tool_input", action: "tokenized" },
      { boundary: "tool_input", action: "detokenized", toolId: "mail.send" },
      { boundary: "tool_output", action: "tokenized" },
    ]);
    for (const event of result.events) {
      expect(JSON.stringify(event)).not.toContain(email);
      expect(JSON.stringify(event)).not.toContain(card);
    }
    for await (const event of store.read(result.events[0]?.runId ?? "", { fromSeq: 0 })) {
      expect(JSON.stringify(event)).not.toContain(email);
      expect(JSON.stringify(event)).not.toContain(card);
    }
    expect(files.size).toBe(1);
    for (const bytes of files.values()) {
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("<CREDIT_CARD_1>");
      expect(text).not.toContain(email);
      expect(text).not.toContain(card);
    }
    const toolResult = result.events.find((event) => event.type === "tool_result");
    expect(JSON.stringify(toolResult?.result)).toContain("<CREDIT_CARD_1>");
    const inputSeq = result.events.find((event) => event.type === "pii_action")?.seq;
    expect(inputSeq).toBeLessThan(intent?.seq ?? 0);
  });

  it.each([
    { block: true, code: "pii_blocked" },
    { detectorFailure: true, code: "pii_detector_failed" },
    { vaultFailure: true, code: "pii_vault_failed" },
  ])(
    "denies preparation failure without persisting arguments ($code)",
    async ({ code, ...options }) => {
      const { result, execute, files, model } = await pipeline(options);
      expect(execute).not.toHaveBeenCalled();
      expect(files.size).toBe(0);
      const intent = result.events.find((event) => event.type === "tool_intent");
      expect(intent?.args).toBeNull();
      expect(intent?.policyDecision).toBe("deny");
      expect(result.events.find((event) => event.type === "tool_result")).toMatchObject({
        outcome: "denied",
        errorCode: code,
        result: null,
      });
      for (const event of result.events) {
        expect(JSON.stringify(event)).not.toContain(email);
      }
      const messages = model.requests[1]?.request.messages ?? [];
      const assistantMessage = messages.find(({ role }) => role === "assistant");
      const toolMessage = messages.find(({ role }) => role === "tool");
      expect(
        assistantMessage?.parts.some(
          (part) => part.type === "tool_call" && part.callId === callId && part.args === null,
        ),
      ).toBe(true);
      expect(
        toolMessage?.parts.some(
          (part) =>
            part.type === "tool_result" &&
            part.callId === callId &&
            part.result === null &&
            part.isError,
        ),
      ).toBe(true);
    },
  );

  it("tokenizes edited approval arguments before recording and executing them", async () => {
    const { tool, execute } = await pipeline();
    execute.mockClear();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const runId = "00000000000000000000000070";
    const segmentId = "11111111111111111111111170";
    const approvalCallId = "00000000000000000000000071";
    const approvalId = "00000000000000000000000072";
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await recorder.recordBatch([
        { type: "run_created", v: 1, configHash: "a".repeat(64), policyVersion: "test.policy" },
        { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
        {
          type: "tool_intent",
          v: 1,
          callId: approvalCallId,
          toolId: "mail.send",
          idempotent: false,
          policyDecision: "ask",
          argsHash: "b".repeat(64),
          args: { to: "draft-recipient", note: "draft-note" },
        },
        {
          type: "approval_requested",
          v: 1,
          approvalId,
          callId: approvalCallId,
          payload: JsonValue.parse(
            buildApprovalPayload({
              call: {
                callId: approvalCallId,
                toolId: "mail.send",
                args: { to: "draft-recipient", note: "draft-note" },
              },
              rule: { id: "ask_mail", reason: "outbound_email", editable: ["/to", "/note"] },
            }),
          ),
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "suspended",
          reason: "awaiting_approval",
        },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a suspended run.");
      }
      return last;
    });

    const resolution = await resolveApproval(
      store,
      runId,
      approvalId,
      "edit",
      { to: email, note: email },
      clock,
      tool,
      { decidedBy: "human", approverId: "cli.test" },
    );
    expect(resolution).toMatchObject({
      decision: "edit",
      edits: { to: "<EMAIL_1>", note: "<EMAIL_1>" },
    });

    const resumedRecorder = new RunRecorder(
      store,
      runId,
      segmentId,
      await store.head(runId),
      clock,
    );
    await resumedRecorder.withStepSpan(RUN_SPAN, {}, async () =>
      resumedRecorder.record({
        type: "run_status_changed",
        v: 1,
        from: "suspended",
        to: "running",
        reason: "resumed",
      }),
    );
    const beforeApply: Event[] = [];
    for await (const event of store.read(runId)) {
      beforeApply.push(event);
    }
    await applyResolvedApprovals(
      {
        recorder: resumedRecorder,
        tool,
        clock,
        runId,
        policy: allowAllPolicy,
        signal: new AbortController().signal,
      },
      foldRunState(beforeApply),
    );

    const events: Event[] = [];
    for await (const event of store.read(runId)) {
      events.push(event);
      expect(JSON.stringify(event)).not.toContain(email);
    }
    expect(execute.mock.calls[0]?.[0].args).toEqual({ to: email, note: "<EMAIL_1>" });
    const expectedArgsHash = createHash("sha256")
      .update('{"note":"<EMAIL_1>","to":"<EMAIL_1>"}')
      .digest("hex");
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      outcome: "ok",
      executedArgsHash: expectedArgsHash,
    });
    expect(events.find((event) => event.type === "approval_resolved")).toMatchObject({
      edits: { to: "<EMAIL_1>", note: "<EMAIL_1>" },
    });
  });

  it("rejects oversized text before offloading", async () => {
    const { result, files } = await pipeline({ largeText: true });
    expect(files.size).toBe(0);
    expect(result.events.find((event) => event.type === "tool_result")).toMatchObject({
      outcome: "error",
      errorCode: "pii_input_too_large",
      result: null,
    });
  });

  it("demonstrates the negative control when the PII boundary is removed", async () => {
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({ enabled: false }) },
      {
        store,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: new FakeModelPort([completion(true), completion()]),
        policy: allowAllPolicy,
        tool: {
          describe: () => ({ idempotent: true, timeoutMs: 1000 }),
          execute: () => Promise.resolve({ outcome: "ok", result: null satisfies JsonValue }),
        },
      },
    );
    try {
      const result = await runtime.run("negative control");
      expect(JSON.stringify(result.events)).toContain(email);
    } finally {
      await runtime.close();
    }
  });
});
