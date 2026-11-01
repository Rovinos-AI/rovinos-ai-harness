// SPDX-License-Identifier: Apache-2.0
// The peer supplies hostile wire data; production MCP, PII, broker and run-loop APIs enforce policy.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import { createRuntime, type Runtime, type HumanInputChannel } from "@rovinos/core";
import { ObedientModel } from "@rovinos/core/testing";
import { checkElicitationUrl } from "@rovinos/mcp";
import {
  Code,
  FakeClock,
  Id,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  type InputRequest,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { InProcessBackend } from "@rovinos/sandbox";
import { createTelemetrySdk, type TelemetrySdkOptions } from "@rovinos/telemetry";
import { createTestContextManager, createTestMetricCollector } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createHostilePeer,
  HOSTILE_BEHAVIORS,
  REQUEST_STATE,
  type HostileBehavior,
} from "./fixtures/hostile-elicitation-server/server.js";

const ERAS = ["2026-07-28", "2025-11-25"] as const;
type Era = (typeof ERAS)[number];
type ExportedSpan = Parameters<TelemetrySdkOptions["spanExporter"]["export"]>[0][number];
type ExportedLog = Parameters<TelemetrySdkOptions["logExporter"]["export"]>[0][number];
const spans: ExportedSpan[] = [];
const logRecords: ExportedLog[] = [];
const metricCollector = createTestMetricCollector();
let telemetry: ReturnType<typeof createTelemetrySdk>;

beforeAll(() => {
  context.setGlobalContextManager(createTestContextManager());
  metrics.setGlobalMeterProvider(metricCollector.provider);
  telemetry = createTelemetrySdk({
    spanExporter: {
      export: (batch, callback) => {
        spans.push(...batch);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    },
    logExporter: {
      export: (batch, callback) => {
        logRecords.push(...batch);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    },
    telemetry: { sentinel: { enabled: false, minValueLength: 6 }, correlation: { enabled: false } },
  });
  trace.setGlobalTracerProvider(telemetry.tracerProvider);
  logs.setGlobalLoggerProvider(telemetry.loggerProvider);
});

afterAll(async () => {
  await telemetry.forceFlush();
  await telemetry.tracerProvider.shutdown();
  await telemetry.loggerProvider.shutdown();
  await metricCollector.provider.shutdown();
  metrics.disable();
  trace.disable();
  logs.disable();
  context.disable();
  await rm(resolve(".elicitation-test-data"), { recursive: true, force: true });
});

async function counters(): Promise<Record<string, number>> {
  await metricCollector.forceFlush();
  const snapshot = metricCollector.getMetrics().at(-1);
  const totals: Record<string, number> = {};
  for (const scope of snapshot?.scopeMetrics ?? []) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== "harness.mcp.input_requests") {
        continue;
      }
      for (const point of metric.dataPoints) {
        const outcome = point.attributes["harness.mcp.input_requests.outcome"];
        if (typeof outcome === "string" && typeof point.value === "number") {
          expect(Object.keys(point.attributes)).toEqual(["harness.mcp.input_requests.outcome"]);
          totals[outcome] = (totals[outcome] ?? 0) + point.value;
        }
      }
    }
  }
  return totals;
}

function difference(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(after)
      .map(([key, value]) => [key, value - (before[key] ?? 0)] as const)
      .filter(([, value]) => value !== 0),
  );
}

async function within<T>(operation: Promise<T>, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(code));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(behavior: HostileBehavior, era: Era, tool = "attack") {
  const canary = `seed-${createHash("sha256").update(`25.8:${era}:${behavior}`).digest("hex").slice(0, 20)}@example.test`;
  const peer = await within(createHostilePeer(behavior, era, canary), "fixture_peer_init_timeout");
  const workspaceRoot = resolve(".elicitation-test-data", `${era}-${behavior}-${tool}`);
  const store = new InMemoryEventStore();
  const ids = new SequentialIdGenerator();
  const presented: InputRequest[] = [];
  const channel: HumanInputChannel = {
    id: Code.parse("cli.synthetic"),
    available: () => true,
    present: (request) => {
      presented.push(request);
      return Promise.resolve({
        action: "accept",
        ...(request.mode === "form" ? { answer: answerFor(request) } : {}),
        principal: Code.parse("cli.synthetic"),
      });
    },
  };
  const model = new ObedientModel({
    ids,
    bootstrapCall: { toolId: Code.parse(`hostile.${tool}`), args: {} },
  });
  const server = ServerConfigSchema.parse({
    id: "hostile",
    protocol: era,
    transport:
      era === "2026-07-28"
        ? { kind: "http", url: "https://fixture.example.test/mcp" }
        : { kind: "stdio", command: "never-spawned" },
    idempotentTools: ["attack", "confirm_action", "connect_account"],
    elicitation: {
      enabled: true,
      modes: ["form", "url"],
      maxRounds: 2,
      maxPerRun: 3,
      maxRequestStateBytes: 128,
      legacyLiveTimeoutMs: 100,
    },
    timeouts: { connectMs: 1_000, callMs: 2_000 },
  });
  const runtime = await within(
    createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: true }),
        servers: [server],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(100),
        ids,
        model,
        sandboxBackend: new InProcessBackend({ workspaceRoot, logger: { log: () => undefined } }),
        mcpTransportFactory: () => peer.client,
        inputChannels: [channel],
        policy: {
          version: Code.parse("test.allow"),
          decide: () => ({
            decision: "allow",
            ruleId: "test.allow",
            reason: "allowed",
            editable: [],
          }),
        },
        flushTelemetry: () => telemetry.forceFlush(),
      },
    ),
    "fixture_runtime_init_timeout",
  );
  return {
    runtime,
    peer,
    model,
    presented,
    canary,
    close: async () => {
      await runtime.close();
      await peer.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function answerPending(runtime: Runtime, result: Awaited<ReturnType<Runtime["run"]>>) {
  for (const request of result.events.filter((event) => event.type === "input_requested")) {
    if (
      !result.events.some(
        (event) => event.type === "input_resolved" && event.requestId === request.requestId,
      )
    ) {
      await runtime.resolveInput(Id.parse(result.events[0]?.runId), request.requestId, {
        action: "accept",
        ...(request.mode === "form" ? { answer: answerFor(request) } : {}),
        principal: Code.parse("cli.synthetic"),
      });
    }
  }
}

function assertModelCannotAnswer(model: ObedientModel) {
  const forbidden = ["answer_input", "harness.inputs.answer", "harness.input.resolve"];
  for (const { request } of model.requests) {
    expect(request.tools?.some(({ toolId }) => forbidden.includes(toolId))).toBe(false);
    expect(JSON.stringify(request.messages)).not.toContain("forged");
  }
}

function answerFor(request: Pick<InputRequest, "mode" | "schema">) {
  if (request.mode === "url") {
    return {};
  }
  return request.schema?.properties.confirmed === undefined
    ? { answer: "synthetic" }
    : { confirmed: true };
}

interface Scenario {
  readonly era: Era;
  readonly behavior: HostileBehavior;
  readonly test: Awaited<ReturnType<typeof fixture>>;
  readonly result: Awaited<ReturnType<Runtime["run"]>>;
  readonly events: Awaited<ReturnType<Runtime["run"]>>["events"];
  readonly counts: Record<string, number>;
}

function assertInvalid(scenario: Scenario) {
  expect(scenario.events.filter((event) => event.type === "input_requested")).toEqual([]);
  expect(scenario.test.presented).toEqual([]);
  expect(scenario.result.events).toContainEqual(
    expect.objectContaining({ type: "tool_result", outcome: "error" }),
  );
  expect(scenario.counts).toEqual({ rejected: 1 });
}

function assertDeclined(scenario: Scenario) {
  expect(scenario.test.presented).toEqual([]);
  expect(
    scenario.events.filter((event) => event.type === "input_resolved").map((event) => event.action),
  ).toEqual(["decline"]);
  const sensitive = scenario.behavior === "password" || scenario.behavior === "card";
  expect(scenario.counts).toEqual({ [sensitive ? "declined_sensitive" : "rejected"]: 1 });
}

function assertFlood(scenario: Scenario) {
  expect(scenario.events.filter((event) => event.type === "input_requested")).toEqual([]);
  expect(scenario.counts).toEqual({ rate_limited: 1 });
}

function assertEndless(scenario: Scenario) {
  expect(scenario.events.filter((event) => event.type === "input_requested")).toHaveLength(2);
  expect(scenario.result.events).toContainEqual(
    expect.objectContaining({ type: "tool_result", errorCode: "mcp_input_rounds_exceeded" }),
  );
  expect(scenario.counts).toEqual({ asked: 2, rounds_exceeded: 1 });
}

function assertAsked(scenario: Scenario) {
  expect(scenario.events.filter((event) => event.type === "input_requested")).toHaveLength(1);
  expect(scenario.counts).toEqual({ asked: 1 });
}

function assertPunycode(scenario: Scenario) {
  assertAsked(scenario);
  const request = scenario.events.find((event) => event.type === "input_requested");
  expect(checkElicitationUrl(request?.url ?? "")).toMatchObject({
    accepted: true,
    suspicious: true,
  });
}

const assertions: Record<
  Exclude<HostileBehavior, "no_active_call">,
  (scenario: Scenario) => void
> = {
  password: assertDeclined,
  card: assertDeclined,
  nested: assertInvalid,
  oversized_schema: assertInvalid,
  redos: assertInvalid,
  sampling: assertInvalid,
  roots: assertInvalid,
  oversized_state: assertInvalid,
  endless: assertEndless,
  flood: assertFlood,
  javascript_url: assertDeclined,
  data_url: assertDeclined,
  credential_url: assertDeclined,
  punycode_url: assertPunycode,
  human_instructions: assertAsked,
  model_instructions: assertAsked,
  canary_echo: assertAsked,
};

function assertState(era: Era, calls: Awaited<ReturnType<typeof fixture>>["peer"]["calls"]) {
  const retries = era === "2026-07-28" ? calls.slice(1) : [];
  for (const call of retries) {
    expect(Buffer.from(call.requestState ?? "")).toEqual(Buffer.from(REQUEST_STATE));
    expect(call.rpcId).not.toBe(calls[0]?.rpcId);
    expect(call.arguments).toEqual(calls[0]?.arguments);
  }
}

describe("human-input hostile-server containment", () => {
  it.each(["confirm_action", "connect_account"])(
    "completes sample MRTR %s with human consent and byte-identical state",
    async (tool) => {
      const test = await fixture("canary_echo", "2026-07-28", tool);
      const before = await counters();
      try {
        const waiting = await within(
          test.runtime.run("Retrieve synthetic input."),
          "fixture_run_timeout",
        );
        expect(waiting.status).toBe("suspended");
        expect(waiting.events).toContainEqual(
          expect.objectContaining({ type: "run_status_changed", reason: "awaiting_input" }),
        );
        expect(waiting.events.some((event) => event.type === "tool_result")).toBe(false);
        assertModelCannotAnswer(test.model);
        await within(answerPending(test.runtime, waiting), "fixture_answer_timeout");
        const completed = await within(
          test.runtime.resume(Id.parse(waiting.events[0]?.runId)),
          "fixture_resume_timeout",
        );
        expect(completed.status).toBe("completed");
        expect(test.peer.calls).toHaveLength(2);
        assertState("2026-07-28", test.peer.calls);
        expect(test.peer.calls[1]?.inputResponses).toEqual({
          human: {
            action: "accept",
            content: tool === "confirm_action" ? { confirmed: true } : {},
          },
        });
        expect(difference(before, await counters())).toEqual({ asked: 1 });
      } finally {
        await test.close();
      }
    },
  );

  it.each(["confirm_action_legacy", "connect_account_legacy"])(
    "completes sample live legacy %s through the human broker",
    async (tool) => {
      const test = await fixture("canary_echo", "2025-11-25", tool);
      try {
        const completed = await test.runtime.run("Retrieve synthetic input.");
        expect(completed.status).toBe("completed");
        expect(test.presented).toHaveLength(1);
        expect(completed.events).toContainEqual(
          expect.objectContaining({ type: "input_resolved", action: "accept", decidedBy: "human" }),
        );
        assertModelCannotAnswer(test.model);
      } finally {
        await test.close();
      }
    },
  );

  it("bounds legacy floods at the configured per-run limit", async () => {
    const test = await fixture("flood", "2025-11-25");
    const before = await counters();
    try {
      const result = await test.runtime.run("Retrieve synthetic input.");
      const counts = difference(before, await counters());
      expect({
        presented: test.presented.length,
        requested: result.events.filter((event) => event.type === "input_requested").length,
        counts,
      }).toEqual({ presented: 3, requested: 3, counts: { asked: 3, rate_limited: 1 } });
      expect(
        result.events.filter((event) => event.type === "input_requested").length,
      ).toBeLessThanOrEqual(3);
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "tool_result", errorCode: "mcp_input_rate_limited" }),
      );
      expect(counts).toEqual({ asked: 3, rate_limited: 1 });
    } finally {
      await test.close();
    }
  });

  it("cancels legacy push elicitation outside an active call", async () => {
    const test = await fixture("no_active_call", "2025-11-25");
    try {
      await expect(test.peer.sendOutsideCall()).resolves.toEqual({ action: "cancel", content: {} });
      expect(test.presented).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it.each(
    ERAS.flatMap((era) =>
      HOSTILE_BEHAVIORS.filter((behavior) => behavior !== "no_active_call").map(
        (behavior) => [era, behavior] as const,
      ),
    ),
  )("contains %s %s through the production runtime", async (era, behavior) => {
    const test = await fixture(behavior, era);
    const before = await counters();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_fetch"));
    try {
      let result = await test.runtime.run("Retrieve synthetic input.");
      const collectedEvents = [...result.events];
      for (let round = 0; result.status === "suspended" && round < 3; round++) {
        assertModelCannotAnswer(test.model);
        await answerPending(test.runtime, result);
        result = await test.runtime.resume(Id.parse(result.events[0]?.runId));
        collectedEvents.push(...result.events);
      }
      assertions[behavior]({
        era,
        behavior,
        test,
        result,
        events: collectedEvents,
        counts: difference(before, await counters()),
      });
      assertState(era, test.peer.calls);
      expect(JSON.stringify(collectedEvents)).not.toContain(test.canary);
      expect(JSON.stringify(test.model.requests)).not.toContain(test.canary);
      await telemetry.forceFlush();
      expect(
        JSON.stringify({ spans, logRecords, metrics: metricCollector.getMetrics() }),
      ).not.toContain(test.canary);
      assertModelCannotAnswer(test.model);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await test.close();
    }
  });
});
