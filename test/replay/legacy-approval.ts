// SPDX-License-Identifier: Apache-2.0
import { createRuntime, type PolicyPort } from "@rovinos/core";
import { FakeModelPort, FakeToolPort } from "@rovinos/core/testing";
import { InMemoryEventStore } from "@rovinos/store";
import {
  Code,
  FakeClock,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type NewEvent,
} from "@rovinos/schemas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = { run: RunConfigSchema.parse({}) };

function legacyTool(): FakeToolPort {
  return new FakeToolPort(
    new Map([
      [
        Code.parse("synthetic.editable"),
        {
          idempotent: false,
          timeoutMs: 1_000,
          execute: (call) =>
            Promise.resolve({ outcome: "ok", result: { tool: call.toolId, value: call.args } }),
        },
      ],
    ]),
  );
}

function legacyPolicy(): PolicyPort {
  return {
    version: Code.parse("synthetic.policy"),
    decide: () => ({
      decision: "allow",
      ruleId: Code.parse("synthetic.allow"),
      reason: Code.parse("policy_allowed"),
      editable: [],
    }),
  };
}

function legacyRuntime(store: InMemoryEventStore, dataDir: string, tool: FakeToolPort) {
  return createRuntime(config, {
    dataDir,
    store,
    clock: new FakeClock(1_000),
    ids: new SequentialIdGenerator(),
    model: new FakeModelPort([
      {
        parts: [{ type: "text", text: "synthetic approved answer" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        provider: "synthetic",
        model: "script",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      },
    ]),
    policy: legacyPolicy(),
    tool,
    transientVault: true,
    sandboxBackend: {
      exec: () => Promise.reject(new Error("Unused synthetic sandbox backend.")),
    },
  });
}

/** Approves and resumes a legacy run prefix, returning the tool calls executed on resume. */
export async function resumeLegacyApproval(
  events: readonly Event[],
): Promise<{ readonly status: string; readonly executedToolIds: readonly Code[] }> {
  const resolutionIndex = events.findIndex((event) => event.type === "approval_resolved");
  const prefix = resolutionIndex < 0 ? [] : events.slice(0, resolutionIndex);
  const created = prefix[0];
  const approval = prefix.find((event) => event.type === "approval_requested");
  if (created?.type !== "run_created" || approval?.type !== "approval_requested") {
    throw new Error("Expected a suspended legacy approval run.");
  }
  const initialEvents: NewEvent[] = prefix.map(({ seq, ...event }, index) => {
    if (seq !== index) {
      throw new Error("Expected a contiguous legacy approval prefix.");
    }
    return event;
  });
  const store = new InMemoryEventStore();
  await store.append(created.runId, initialEvents, 0);
  const tool = legacyTool();
  const dataDir = await mkdtemp(join(tmpdir(), "harness-legacy-approval-"));
  const runtime = await legacyRuntime(store, dataDir, tool);
  try {
    await runtime.resolveApproval(created.runId, approval.approvalId, "approve", {
      metadata: {
        decidedBy: "human",
        approverId: Code.parse("cli.synthetic"),
      },
    });
    const result = await runtime.resume(created.runId);
    return {
      status: result.status,
      executedToolIds: tool.calls.map(({ call }) => call.toolId),
    };
  } finally {
    try {
      await runtime.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}
