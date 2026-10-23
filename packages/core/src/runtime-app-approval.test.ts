// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  Code,
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
} from "@harness/schemas";
import { RunnerPool, type RunnerPoolRunner, type SandboxBackend } from "@harness/sandbox";
import { InMemoryEventStore } from "@harness/store";
import { createEventBuilders } from "@harness/store/testing";
import { createTestContextManager, createTestSpanCollector } from "@harness/telemetry/testing";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import { FakeModelPort } from "./testing/fake-model.js";
import type { ModelPort, PolicyDecision, PolicyPort, ToolPort } from "./ports.js";
import { foldRunState } from "./run-state.js";
import {
  AppApprovalPolicyError,
  appApprovalContext,
  approvedAppPolicy,
} from "./app-approval-context.js";

const ask: PolicyDecision = {
  decision: "ask",
  ruleId: "app_review",
  reason: "review",
  editable: ["/value"],
  approvalTtlMs: 100,
};
const human = { metadata: { decidedBy: "human" as const, approverId: Code.parse("cli.app_test") } };

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

async function eventsFor(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function scenario(
  action: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  sandboxBackend?: SandboxBackend,
) {
  trace.disable();
  otelContext.disable();
  const collector = createTestSpanCollector();
  trace.setGlobalTracerProvider(collector.provider);
  otelContext.setGlobalContextManager(createTestContextManager());
  const fixture = await setup(sandboxBackend);
  try {
    await action(fixture);
  } finally {
    await fixture.runtime.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await collector.provider.shutdown();
    trace.disable();
    otelContext.disable();
  }
}

async function setup(
  sandboxBackend: SandboxBackend = {
    exec: () => Promise.reject(new Error("Unused synthetic backend")),
  },
) {
  const directory = await mkdtemp(".runtime-app-approval-");
  const clock = new FakeClock(10);
  const ids = new SequentialIdGenerator();
  const store = new InMemoryEventStore();
  const builders = createEventBuilders();
  const runId = Id.parse(ids.next());
  const created = { ...builders.runCreated(runId), requestedBy: Code.parse("cli.app_test") };
  await store.append(
    runId,
    [
      created,
      {
        runId,
        ts: created.ts,
        segmentId: created.segmentId,
        traceId: created.traceId,
        spanId: created.spanId,
        v: 1,
        type: "run_input",
        inputKind: "initial",
        input: "Synthetic app run",
      },
      builders.runStatusChanged(runId, "pending", "running"),
    ],
    0,
  );
  const policyState = { decision: ask };
  const setDecision = (decision: PolicyDecision) => {
    policyState.decision = decision;
  };

  const decide = vi.fn<PolicyPort["decide"]>((_call, context) =>
    context.app === "synthetic.app"
      ? policyState.decision
      : {
          decision: "deny",
          ruleId: "not_an_app",
          reason: "app_context_missing",
          editable: [],
        },
  );
  const execute = vi.fn<ToolPort["execute"]>(() =>
    Promise.resolve({ outcome: "ok", result: { delivered: true } }),
  );
  const tool = {
    describe: (): ReturnType<ToolPort["describe"]> => ({ idempotent: true, timeoutMs: 1000 }),
    prepare: (call) => Promise.resolve(call),
    execute,
  } satisfies ToolPort;
  const config = { run: RunConfigSchema.parse({}) };
  const overrides = {
    store,
    clock,
    ids: { next: () => Id.parse(ids.next()) },
    dataDir: directory,
    transientVault: true,
    sandboxBackend,
    tool,
    policy: { version: Code.parse("app_test"), decide },
    model: new FakeModelPort([
      {
        provider: "synthetic",
        model: "synthetic",
        parts: [{ type: "text", text: "Done" }],
        providerBlobs: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
      },
    ]),
  };
  const runtime = await createRuntime(config, overrides);
  const call = {
    callId: Id.parse(ids.next()),
    toolId: Code.parse("synthetic.write"),
    args: { value: "original" },
  };
  const context = {
    runId,
    policyContext: { subagent: false as const, app: Code.parse("synthetic.app") },
  };
  const request = (args = call.args) => runtime.onAppCallApproval({ ...call, args }, ask, context);
  const pending = async () => {
    await vi.waitFor(async () => {
      expect(await runtime.hasPendingApproval(runId)).toBe(true);
    });
    const state = foldRunState(await eventsFor(store, runId));
    const approval = [...state.pendingApprovals.values()][0];
    if (approval === undefined) {
      throw new Error("Missing approval");
    }
    return approval;
  };
  return {
    directory,
    runtime,
    store,
    runId,
    call,
    context,
    clock,
    decide,
    execute,
    setDecision,
    request,
    pending,
    config,
    overrides,
  };
}

describe("runtime app approval execution", () => {
  it("returns a suspended live run after an app approval advances its recorder", () =>
    scenario(async (f) => {
      const entered = deferred();
      const released = deferred();
      const model: ModelPort = {
        complete: async (request, context) => {
          entered.resolve();
          await released.promise;
          return f.overrides.model.complete(request, context);
        },
      };
      const runtime = await createRuntime(f.config, { ...f.overrides, model });
      const run = runtime.start("Synthetic live app approval");
      let response: ReturnType<typeof runtime.onAppCallApproval> | undefined;
      try {
        await entered.promise;
        response = runtime.onAppCallApproval(f.call, ask, { ...f.context, runId: run.runId });
        await vi.waitFor(async () => {
          expect(await runtime.hasPendingApproval(run.runId)).toBe(true);
        });
        released.resolve();
        await expect(run.completion).resolves.toMatchObject({ status: "suspended" });
        expect(f.execute).not.toHaveBeenCalled();
      } finally {
        released.resolve();
        await runtime.cancel(run.runId);
        await response;
        await runtime.close();
      }
    }));

  it("enforces newly required separation of duties after approval", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      f.setDecision({ ...ask, separationOfDuties: true });
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: "approver_is_requester" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));

  it("rejects invalid callback decisions, unavailable runs, and unknown tools without execution", () =>
    scenario(async (f) => {
      await expect(
        f.runtime.onAppCallApproval(f.call, { ...ask, decision: "allow" }, f.context),
      ).resolves.toMatchObject({ isError: true, content: [{ text: "policy_error" }] });
      await expect(
        f.runtime.onAppCallApproval(f.call, ask, {
          ...f.context,
          runId: Id.parse("99999999999999999999999999"),
        }),
      ).resolves.toMatchObject({ isError: true, content: [{ text: "app_run_unavailable" }] });
      vi.spyOn(f.overrides.tool, "describe").mockReturnValue(undefined);
      await expect(f.request()).resolves.toMatchObject({
        isError: true,
        content: [{ text: "unknown_tool" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));

  it("does not grant authority to unbound app content or missing app policy", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      const history = await eventsFor(f.store, f.runId);
      const intent = history.find((event) => event.type === "tool_intent");
      if (intent?.type !== "tool_intent") {
        throw new Error("Missing intent");
      }
      expect(
        appApprovalContext(
          intent,
          history.filter((event) => event.type !== "app_content"),
        ),
      ).toBeUndefined();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      const resolution = (await eventsFor(f.store, f.runId)).find(
        (event) => event.type === "approval_resolved",
      );
      if (resolution?.type !== "approval_resolved") {
        throw new Error("Missing resolution");
      }
      expect(() =>
        approvedAppPolicy({
          options: { clock: f.clock, history },
          intent,
          approval,
          resolution,
          args: intent.args,
        }),
      ).toThrow(AppApprovalPolicyError);
      await f.runtime.cancel(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: "app_run_unavailable" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));

  it("creates exactly one durable approval and intent, suspends, and delivers the resumed MCP result", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      expect(f.execute).not.toHaveBeenCalled();
      await expect(f.request()).resolves.toMatchObject({ isError: true });
      const before = await eventsFor(f.store, f.runId);
      expect(foldRunState(before).status).toBe("suspended");
      expect(before.filter((event) => event.type === "tool_intent")).toHaveLength(1);
      expect(before.filter((event) => event.type === "approval_requested")).toHaveLength(1);
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toEqual({
        content: [{ type: "text", text: '{"delivered":true}' }],
        isError: false,
      });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.decide.mock.calls.every(([, context]) => context.app === "synthetic.app")).toBe(
        true,
      );
      expect(
        (await eventsFor(f.store, f.runId)).filter((event) => event.type === "tool_intent"),
      ).toHaveLength(1);
    }));

  it("executes an app-call approval resumed on a pooled runtime while holding its runner lease", () => {
    let leaseHeld = false;
    let acquired = 0;
    let released = 0;
    const runner: RunnerPoolRunner = {
      healthCheck: () => Promise.resolve(true),
      acquireLease: () => {
        acquired += 1;
        leaseHeld = true;
        return Promise.resolve();
      },
      releaseLease: () => {
        released += 1;
        leaseHeld = false;
        return Promise.resolve();
      },
      exec: vi.fn(() =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
          timedOut: false,
          durationMs: 0,
        }),
      ),
      fetch: vi.fn(() =>
        Promise.resolve({
          url: "https://example.test/",
          status: 200,
          contentType: "text/plain",
          truncated: false,
          untrusted: true as const,
          text: "",
          hiddenTextDropped: 0,
        }),
      ),
      fileOperation: vi.fn(() => Promise.resolve({ entries: [], truncated: false })),
      createArchive: vi.fn(() => Promise.resolve(Readable.from([]))),
      restoreArchive: vi.fn(() => Promise.resolve()),
      hasWorkspace: vi.fn(() => Promise.resolve(false)),
    };
    const pool = new RunnerPool({ runners: [runner] });
    return scenario(async (f) => {
      f.execute.mockImplementation(() => {
        expect(leaseHeld).toBe(true);
        return Promise.resolve({ outcome: "ok", result: { delivered: true } });
      });
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({ isError: false });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(acquired).toBe(1);
      expect(released).toBe(1);
      expect(leaseHeld).toBe(false);
    }, pool);
  });

  it.each(["deny", "expiry"] as const)("returns a typed %s error without executing", (kind) =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(
        f.runId,
        approval.approvalId,
        "deny",
        kind === "expiry"
          ? {
              metadata: { decidedBy: "expiry", reason: Code.parse("expired") },
            }
          : human,
      );
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: kind === "expiry" ? "approval_expired" : "approval_denied" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }),
  );

  it("tokenizes stored arguments and editable replacements before policy recheck and execution", () =>
    scenario(async (f) => {
      const response = f.request({ value: "synthetic.person@example.test" });
      const approval = await f.pending();
      expect(JSON.stringify(await eventsFor(f.store, f.runId))).not.toContain(
        "synthetic.person@example.test",
      );
      f.setDecision({ ...ask, decision: "allow" });
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "edit", {
        ...human,
        edits: { value: "edited.person@example.test" },
      });
      const persisted = await eventsFor(f.store, f.runId);
      expect(JSON.stringify(persisted)).not.toContain("edited.person@example.test");
      const resolution = persisted.find((event) => event.type === "approval_resolved");
      expect(JSON.stringify(resolution)).toContain("<EMAIL_");
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({ isError: false });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.decide.mock.calls.at(-1)?.[0].args).toEqual(
        resolution?.type === "approval_resolved" ? resolution.edits : undefined,
      );
    }));

  it("rejects newly denied edits without unauthorized execution", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "edit", {
        ...human,
        edits: { value: "blocked" },
      });
      f.setDecision({ ...ask, decision: "deny", reason: "edited_args_denied" });
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: "edited_args_denied" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));

  it("rechecks persisted app policy after a crash between approval and execution", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      f.setDecision({ ...ask, decision: "deny", reason: "policy_changed" });
      const restarted = await createRuntime(f.config, f.overrides);
      try {
        await restarted.resume(f.runId);
        await expect(response).resolves.toMatchObject({
          isError: true,
          content: [{ text: "policy_changed" }],
        });
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.decide).toHaveBeenCalledWith(expect.anything(), {
          subagent: false,
          app: "synthetic.app",
        });
      } finally {
        await restarted.close();
      }
    }));

  it("rejects approval that expired before execution", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      f.clock.advance(100);
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: "approval_expired" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));

  it("rechecks expiry after preparation before executing an approved tool", () =>
    scenario(async (f) => {
      const response = f.request();
      const approval = await f.pending();
      await f.runtime.resolveApproval(f.runId, approval.approvalId, "approve", human);
      vi.spyOn(f.overrides.tool, "prepare").mockImplementation((call) => {
        f.clock.advance(100);
        return Promise.resolve(call);
      });
      await f.runtime.resume(f.runId);
      await expect(response).resolves.toMatchObject({
        isError: true,
        content: [{ text: "approval_expired" }],
      });
      expect(f.execute).not.toHaveBeenCalled();
    }));
});
