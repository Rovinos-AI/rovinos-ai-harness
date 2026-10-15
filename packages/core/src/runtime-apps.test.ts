// SPDX-License-Identifier: Apache-2.0
import { Code, Id, type NewEvent } from "@harness/schemas";
import { FakeClock } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { context as otelContext, trace } from "@opentelemetry/api";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { describe, expect, it, vi } from "vitest";
import { foldRunState } from "./run-state.js";
import { createRuntimeAppCallbacks } from "./runtime-apps.js";

const builders = createEventBuilders();

async function addRun(store: InMemoryEventStore, pendingApproval: boolean) {
  const runId = builders.nextRunId();
  const approvalId = builders.nextRunId();
  const events: NewEvent[] = [
    builders.runCreated(runId),
    builders.runStatusChanged(runId, "pending", "running"),
    ...(pendingApproval
      ? [
          {
            runId,
            ts: 2,
            v: 1,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId: runId,
            type: "approval_requested" as const,
            approvalId,
            callId: builders.nextRunId(),
            payload: {},
          },
          builders.runStatusChanged(runId, "running", "suspended"),
        ]
      : []),
  ];
  await store.append(runId, events, 0);
  return { runId, approvalId };
}

async function withTracing(action: () => Promise<void>): Promise<void> {
  trace.disable();
  otelContext.disable();
  const collector = createTestSpanCollector();
  trace.setGlobalTracerProvider(collector.provider);
  otelContext.setGlobalContextManager(createTestContextManager());
  try {
    await action();
  } finally {
    await collector.provider.shutdown();
    trace.disable();
    otelContext.disable();
  }
}

describe("runtime reference-host callbacks", () => {
  it("reports pending approval state from the run fold and returns false for missing runs", async () => {
    const store = new InMemoryEventStore();
    const pending = await addRun(store, true);
    const running = await addRun(store, false);
    const callbacks = createRuntimeAppCallbacks({ store, clock: new FakeClock(10) });

    await expect(callbacks.hasPendingApproval(pending.runId)).resolves.toBe(true);
    await expect(callbacks.hasPendingApproval(running.runId)).resolves.toBe(false);
    await expect(
      callbacks.hasPendingApproval(Id.parse("99999999999999999999999999")),
    ).resolves.toBe(false);
    await store.close();
  });

  it("tokenizes app content at model_input and records it as untrusted content", async () =>
    withTracing(async () => {
      const store = new InMemoryEventStore();
      const { runId } = await addRun(store, true);
      const tokenize = vi.fn((_runId, _content, context) => {
        expect(context).toEqual({ boundary: "model_input" });
        return Promise.resolve({ message: "<EMAIL_1>" });
      });
      const callbacks = createRuntimeAppCallbacks({
        store,
        clock: new FakeClock(20),
        tokenize,
      });

      const tokenized = await callbacks.tokenizeAppContent(
        runId,
        { message: "raw-app-content@example.test" },
        { boundary: "model_input" },
      );
      await callbacks.onAppContent({
        runId,
        appId: Code.parse("approval.app"),
        kind: "message",
        content: tokenized,
      });

      const events = [];
      for await (const event of store.read(runId)) {
        events.push(event);
      }
      const appContent = events.at(-1);
      expect(tokenized).toEqual({ message: "<EMAIL_1>" });
      expect(appContent).toMatchObject({
        type: "app_content",
        source: "app",
        appId: "approval.app",
        label: "App-provided; untrusted",
        kind: "message",
        content: { message: "<EMAIL_1>" },
      });
      expect(JSON.stringify(appContent)).not.toContain("raw-app-content@example.test");
      expect(foldRunState(events).pendingApprovals.size).toBe(1);
      expect(tokenize).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "run_input")).toBe(false);
      expect(events.some((event) => event.type === "approval_resolved")).toBe(false);
    }));

  it("fails closed when tokenization is absent or fails, and when the run is missing", async () => {
    const store = new InMemoryEventStore();
    const { runId } = await addRun(store, false);
    const content = {
      runId,
      appId: Code.parse("approval.app"),
      kind: "model_context" as const,
      content: { value: "private" },
    };
    const unavailable = createRuntimeAppCallbacks({ store, clock: new FakeClock(1) });
    await expect(
      unavailable.tokenizeAppContent(runId, content.content, { boundary: "model_input" }),
    ).rejects.toMatchObject({ code: "app_content_unavailable" });

    const broken = createRuntimeAppCallbacks({
      store,
      clock: new FakeClock(1),
      tokenize: () => Promise.reject(new Error("private tokenizer failure")),
    });
    await expect(
      broken.tokenizeAppContent(runId, content.content, { boundary: "model_input" }),
    ).rejects.toMatchObject({
      code: "app_content_unavailable",
    });
    await expect(
      broken.onAppContent({ ...content, runId: Id.parse("99999999999999999999999999") }),
    ).rejects.toMatchObject({ code: "app_content_run_unavailable" });
    await store.close();
  });
});
