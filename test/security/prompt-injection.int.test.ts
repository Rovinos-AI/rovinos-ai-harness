// SPDX-License-Identifier: Apache-2.0
// Synthetic ports keep adversarial boundary inputs deterministic while exercising the real run loop.
import { AgentSpawnInputSchema, restrictToolPort, type ToolPort } from "@harness/core";
import { Code, Id, UNREGISTERED_TOOL_ID } from "@harness/schemas";
import { createTelemetrySdk, type TelemetrySdkOptions } from "@harness/telemetry";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoForbiddenExecution,
  ATTACKS,
  runScenario,
  targetIntent,
  targetResult,
  VECTORS,
  type Attack,
  type ScenarioResult,
  type Vector,
} from "./prompt-injection-harness.js";

type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLogRecord = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];
const exportedSpans: ExportedSpan[] = [];
const exportedLogs: ExportedLogRecord[] = [];
let telemetrySdk: ReturnType<typeof createTelemetrySdk> | undefined;

beforeAll(() => {
  telemetrySdk = createTelemetrySdk({
    spanExporter: {
      export: (spans, callback) => {
        exportedSpans.push(...spans);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (records, callback) => {
        exportedLogs.push(...records);
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    telemetry: {
      sentinel: { enabled: false, minValueLength: 6 },
      correlation: { enabled: false },
    },
  });
  if (!trace.setGlobalTracerProvider(telemetrySdk.tracerProvider)) {
    throw new Error("The prompt-injection tracer provider could not be registered.");
  }
  logs.setGlobalLoggerProvider(telemetrySdk.loggerProvider);
});

afterAll(async () => {
  await telemetrySdk?.forceFlush();
  await telemetrySdk?.tracerProvider.shutdown();
  await telemetrySdk?.loggerProvider.shutdown();
});

function flushTelemetry(): Promise<void> {
  return telemetrySdk?.forceFlush() ?? Promise.resolve();
}

async function scenario(
  vector: Vector,
  attack: Attack,
  options: { readonly baseline?: boolean; readonly weakenedPolicy?: boolean } = {},
): Promise<ScenarioResult> {
  return runScenario(vector, attack, { ...options, flushTelemetry });
}

function assertNoCanary(scenarioResult: ScenarioResult): void {
  expect(JSON.stringify(scenarioResult.result.events)).not.toContain(scenarioResult.canary);
  expect(JSON.stringify(scenarioResult.modelRequests)).not.toContain(scenarioResult.canary);
  expect(JSON.stringify({ spans: exportedSpans, logs: exportedLogs })).not.toContain(
    scenarioResult.canary,
  );
}

function hasValueArg(result: ScenarioResult, toolId: string, value: string): boolean {
  const args = result.executedCalls.find((call) => call.toolId === toolId)?.args;
  return args !== null && typeof args === "object" && !Array.isArray(args) && args.value === value;
}

type AttackAssertion = (scenarioResult: ScenarioResult, attack: Attack) => boolean;

const attackAssertions: Record<Attack["kind"], AttackAssertion> = {
  subagent: (result, attack) =>
    targetIntent(result.result.events, attack.toolId)?.policyDecision === "allow" &&
    targetResult(result.result.events, attack.toolId)?.errorCode === "agent_spawn_invalid" &&
    !result.result.events.some((event) => event.type === "subagent_spawned"),
  budget: (result, attack) =>
    targetIntent(result.result.events, attack.toolId) === undefined &&
    result.result.events.some(
      (event) => event.type === "tool_result" && event.errorCode === "unknown_tool",
    ),
  deny: (result, attack) =>
    targetIntent(result.result.events, attack.toolId)?.policyDecision === "deny" &&
    targetResult(result.result.events, attack.toolId)?.outcome === "denied" &&
    !result.executedCalls.some((call) => call.toolId === attack.toolId),
  ask: (result, attack) => {
    const requestTools = result.modelRequests.at(-1)?.request.tools ?? [];
    const approvalTool = "harness.approvals.resolve";
    expect(targetResult(result.result.events, UNREGISTERED_TOOL_ID)).toMatchObject({
      outcome: "denied",
      errorCode: "unknown_tool",
    });
    expect(targetIntent(result.result.events, attack.toolId)?.policyDecision).toBe("ask");
    expect(result.result.status).toBe("suspended");
    expect(targetResult(result.result.events, attack.toolId)?.outcome).not.toBe("ok");
    expect(requestTools.some(({ toolId }) => toolId === approvalTool || toolId === "approve")).toBe(
      false,
    );
    expect(result.result.approvalIds).not.toHaveLength(0);
    expect(result.result.events.some((event) => event.type === "approval_resolved")).toBe(false);
    expect(result.executedCalls.some((call) => call.toolId === attack.toolId)).toBe(false);
    return true;
  },
  "token-send": (result, attack) =>
    targetIntent(result.result.events, attack.toolId)?.policyDecision === "allow" &&
    hasValueArg(result, attack.toolId, "<EMAIL_1>"),
  detokenize: (result, attack) =>
    hasValueArg(result, attack.toolId, result.canary) &&
    result.result.events.some(
      (event) =>
        event.type === "pii_action" &&
        event.boundary === "tool_input" &&
        event.action === "detokenized" &&
        event.toolId === attack.toolId,
    ),
  "sandbox-write": (result, attack) =>
    targetResult(result.result.events, attack.toolId)?.errorCode === "fs_path_invalid" &&
    result.protectedFileContents === "protected policy",
};

describe("prompt-injection resistance", () => {
  it.each(VECTORS.flatMap((vector) => ATTACKS.map((attack) => [vector, attack] as const)))(
    "keeps %s from changing authority during %s",
    async (vector, attack) => {
      const result = await scenario(vector, attack);
      assertNoCanary(result);
      expect(attackAssertions[attack.kind](result, attack)).toBe(true);
      expect(result.result.status).not.toBe("failed");
    },
  );

  it("keeps policy decisions identical to an uninjected baseline", async () => {
    const attack = ATTACKS[0];
    const vector = VECTORS[0];
    const baseline = await scenario(vector, attack, { baseline: true });
    const injected = await scenario(vector, attack);

    expect(targetIntent(injected.result.events, attack.toolId)).toMatchObject({
      policyDecision: targetIntent(baseline.result.events, attack.toolId)?.policyDecision,
      ruleId: targetIntent(baseline.result.events, attack.toolId)?.ruleId,
      policyReason: targetIntent(baseline.result.events, attack.toolId)?.policyReason,
    });
  });

  it("shows that a policy wrapper trusting tool output makes the forbidden path executable", async () => {
    const attack = ATTACKS[0];
    const vector = VECTORS[0];
    const weakened = await scenario(vector, attack, { weakenedPolicy: true });

    expect(targetIntent(weakened.result.events, attack.toolId)?.policyDecision).toBe("allow");
    expect(targetResult(weakened.result.events, attack.toolId)?.outcome).toBe("ok");
    expect(() => {
      assertNoForbiddenExecution(weakened, attack.toolId);
    }).toThrow(`Forbidden tool ${attack.toolId} executed.`);
  });

  it("enforces a configured subagent tool subset and rejects model-supplied widening", async () => {
    const called: string[] = [];
    const parent: ToolPort = {
      getToolSpecs: () => [
        { toolId: "read.safe", description: "read", inputSchema: {} },
        { toolId: "write.secret", description: "write", inputSchema: {} },
      ],
      describe: (toolId) =>
        toolId === "read.safe" || toolId === "write.secret"
          ? { idempotent: true, timeoutMs: 1_000 }
          : undefined,
      execute: (call) => {
        called.push(call.toolId);
        return Promise.resolve({ outcome: "ok", result: null });
      },
    };
    const child = restrictToolPort(parent, [Code.parse("read.safe")]);

    expect(child.getToolSpecs?.().map(({ toolId }) => toolId)).toEqual(["read.safe"]);
    await expect(
      child.execute(
        {
          callId: Id.parse("00000000000000000000000001"),
          toolId: Code.parse("write.secret"),
          args: null,
        },
        {
          runId: Id.parse("00000000000000000000000001"),
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "unknown_tool" });
    expect(called).toEqual([]);
    expect(
      AgentSpawnInputSchema.safeParse({
        role: "worker",
        goal: "write a secret",
        tools: ["write.secret"],
      }).success,
    ).toBe(false);
  });
});
