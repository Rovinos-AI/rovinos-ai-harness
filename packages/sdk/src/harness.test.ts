// SPDX-License-Identifier: Apache-2.0
import type { ModelPort, PolicyPort, ToolPort } from "@harness/core";
import { HarnessConfigSchema } from "@harness/config";
import { InMemoryEventStore } from "@harness/store";
import { Code, FakeClock, Id, SequentialIdGenerator } from "@harness/schemas";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./index.js";
import { GetRunContentOptionsSchema, ListRunsFilterSchema } from "./types.js";
import type { Harness } from "./types.js";

function fakeModel(responses?: readonly string[]): ModelPort {
  let index = 0;
  return {
    complete: () => {
      const text = responses?.[index] ?? "synthetic completion";
      index += 1;
      return Promise.resolve({
        parts: [{ type: "text", text }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        provider: Code.parse("test"),
        model: Code.parse("test-model"),
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
    },
  };
}

function approvalModel(): ModelPort {
  let first = true;
  return {
    complete: () => {
      if (first) {
        first = false;
        return Promise.resolve({
          parts: [
            {
              type: "tool_call",
              callId: Id.parse("00000000000000000000000091"),
              toolId: Code.parse("synthetic.tool"),
              args: { value: "synthetic" },
            },
          ],
          usage: { inputTokens: 2, outputTokens: 3 },
          finishReason: "tool_calls",
          provider: Code.parse("test"),
          model: Code.parse("test-model"),
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        });
      }
      return Promise.resolve({
        parts: [{ type: "text", text: "synthetic completion" }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        provider: Code.parse("test"),
        model: Code.parse("test-model"),
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
    },
  };
}

const askPolicy: PolicyPort = {
  version: Code.parse("test"),
  decide: () => ({
    decision: "ask",
    ruleId: Code.parse("approval"),
    reason: Code.parse("manual_review"),
    editable: [],
  }),
};

const fakeTool: ToolPort = {
  describe: () => ({ idempotent: true, timeoutMs: 1000 }),
  execute: () => Promise.resolve({ outcome: "ok", result: "synthetic tool result" }),
};

const harnesses: Harness[] = [];

async function createTestHarness(options: {
  readonly model?: ModelPort;
  readonly approval?: boolean;
  readonly piiEnabled?: boolean;
} = {}): Promise<{ readonly harness: Harness; readonly store: InMemoryEventStore }> {
  const store = new InMemoryEventStore();
  const harness = await createHarness({
    config: HarnessConfigSchema.parse({
      ...(options.piiEnabled === false ? { pii: { enabled: false } } : {}),
    }),
    overrides: {
      store,
      clock: new FakeClock(10_000),
      ids: new SequentialIdGenerator(),
      transientVault: true,
      model: options.model ?? (options.approval === true ? approvalModel() : fakeModel()),
      ...(options.approval === true
        ? { policy: askPolicy, tool: fakeTool }
        : {}),
    },
  });
  harnesses.push(harness);
  return { harness, store };
}

async function waitForRun(harness: Harness, runId: string, status?: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const run = await harness.getRun(runId);
      if (status === undefined || run.status === status) {
        return run;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error("Run did not reach the expected state.");
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("@harness/sdk", () => {
  it("starts detached runs idempotently and exposes metadata only", async () => {
    const { harness } = await createTestHarness();
    const request = {
      goal: "Synthetic task",
      metadata: { source: "sdk" },
      role: Code.parse("worker"),
      requestedBy: Code.parse("app.demo"),
      idempotencyKey: "repeat-this-request",
    };

    const first = await harness.startRun(request);
    const second = await harness.startRun(request);

    expect(second.runId).toBe(first.runId);
    expect(first.status).toBe("pending");
    const run = await waitForRun(harness, first.runId, "completed");
    expect(run).toMatchObject({
      runId: first.runId,
      status: "completed",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(JSON.stringify(run)).not.toContain("Synthetic task");
    expect((await harness.startRun(request)).status).toBe("completed");
  });

  it("loads configuration from a path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-sdk-config-"));
    const configPath = join(directory, "config.yaml");
    try {
      await writeFile(configPath, "{}\n");
      const harness = await createHarness({
        configPath,
        overrides: {
          store: new InMemoryEventStore(),
          clock: new FakeClock(10_000),
          ids: new SequentialIdGenerator(),
          transientVault: true,
          model: fakeModel(),
        },
      });
      harnesses.push(harness);
      const started = await harness.startRun({ goal: "Synthetic config-path task" });
      await waitForRun(harness, started.runId, "completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await expect(createHarness({ configPath })).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("lists metadata pages and continues completed runs", async () => {
    const { harness } = await createTestHarness();
    const first = await harness.startRun({ goal: "Synthetic first task" });
    await waitForRun(harness, first.runId, "completed");
    const next = await harness.continueRun(first.runId, { goal: "Synthetic follow-up" });

    expect(next.status).toBe("completed");
    const page = await harness.listRuns({ status: "completed", limit: 1 });
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(() => ListRunsFilterSchema.parse({ status: "not-a-status" })).toThrow();
  });

  it("returns tokenized content only when explicitly requested", async () => {
    const { harness } = await createTestHarness();
    const started = await harness.startRun({ goal: "Contact alice@example.test" });
    await waitForRun(harness, started.runId, "completed");

    const content = await harness.getRunContent(started.runId, { reveal: false });
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("<EMAIL_1>");
    expect(serialized).not.toContain("alice@example.test");
    expect(() => GetRunContentOptionsSchema.parse({ reveal: true })).toThrow();
  });

  it("refuses content access when tokenization is disabled", async () => {
    const { harness } = await createTestHarness({ piiEnabled: false });
    const started = await harness.startRun({ goal: "Synthetic content" });
    await waitForRun(harness, started.runId, "completed");

    await expect(harness.getRunContent(started.runId, { reveal: false })).rejects.toMatchObject({
      code: "sdk_content_unavailable",
    });
  });

  it("watches safe events and accepts cooperative cancellation", async () => {
    const { harness } = await createTestHarness();
    const started = await harness.startRun({ goal: "Never expose this event canary" });
    await waitForRun(harness, started.runId, "completed");
    const events: unknown[] = [];
    for await (const event of harness.watch(started.runId, { fromSeq: 0 })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Never expose this event canary");
    expect(await harness.cancelRun(started.runId)).toBe("already_terminal");
    await expect(harness.getRun("invalid")).rejects.toThrow();
  });

  it("resolves approvals and resumes suspended runs", async () => {
    const { harness } = await createTestHarness({ approval: true });
    const started = await harness.startRun({ goal: "Synthetic approval task" });
    const suspended = await waitForRun(harness, started.runId, "suspended");
    const approvalId = suspended.pendingApprovals[0];
    expect(approvalId).toBeDefined();
    if (approvalId === undefined) {
      throw new Error("Expected one pending approval.");
    }

    const resolved = await harness.resolveApproval(approvalId, "approve", {
      principal: Code.parse("human.test"),
    });
    expect(resolved).toMatchObject({ runId: started.runId, approvalId, decision: "approve" });
    const resumed = await harness.resumeRun(started.runId);
    expect(resumed.status).toBe("completed");
  });

  it("validates answer requests and reports the unimplemented input contract safely", async () => {
    const { harness } = await createTestHarness();
    await expect(
      harness.answerInput("00000000000000000000000099", {
        action: Code.parse("answer"),
        content: { text: "synthetic" },
        principal: Code.parse("human.test"),
      }),
    ).rejects.toMatchObject({ code: "sdk_input_unavailable" });
  });

  it("stops subscriptions and rejects operations after close", async () => {
    const { harness } = await createTestHarness();
    await harness.close();
    await expect(harness.listRuns()).rejects.toMatchObject({ code: "sdk_closed" });
    await harness.close();
  });
});
