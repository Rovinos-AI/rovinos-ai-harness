// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import { createRuntime as composeRuntime, type RuntimeOverrides } from "@harness/core";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextInspectionSchema,
  Event as EventSchema,
  Id,
  parseJson,
  type JsonValue,
} from "@harness/schemas";
import { StrategyComparisonReportSchema } from "@harness/context";
import { InMemoryEventStore } from "@harness/store";
import { SqliteEventStore } from "@harness/store-sqlite";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { describe, expect, it, vi } from "vitest";
import type { CliContext } from "../command.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { contextCommand } from "./context.js";

const runId = "00000000000000000000000000";
const handle = "wf_00000000000000000000000000";

function event(seq: number, payload: Record<string, unknown>) {
  return EventSchema.parse({
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
    ...payload,
  });
}

function response(seq: number, content: unknown[]) {
  return event(seq, {
    type: "model_response",
    requestId: runId,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    content,
    providerBlobs: null,
  });
}

async function harness() {
  const store = new InMemoryEventStore();
  const events = [
    event(0, { type: "run_created", configHash: "a".repeat(64), policyVersion: "test" }),
    event(1, { type: "run_input", inputKind: "initial", input: "<EMAIL_1>" }),
    response(2, [{ type: "text", text: "old_tokenized_text" }]),
    event(3, {
      type: "context_compacted",
      fromSeq: 2,
      toSeq: 2,
      strategy: "summarizing",
      strategyVersion: "v1",
      summary: "tokenized_summary",
    }),
    response(4, [
      { type: "tool_call", callId: runId, toolId: "test", args: { token: "<EMAIL_2>" } },
    ]),
    event(5, {
      type: "tool_result",
      callId: runId,
      toolId: "test",
      outcome: "ok",
      latencyMs: 0,
      result: { $offloaded: { handle, bytes: 10_000, preview: "tokenized_preview" } },
    }),
    response(6, [{ type: "text", text: "latest_tokenized_text" }]),
  ];
  await store.append(
    runId,
    events.map(({ seq: _seq, ...value }) => value),
    0,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const append = vi.spyOn(store, "append");
  const close = vi.fn(() => Promise.resolve());
  const modelCall = vi.fn(() => Promise.reject(new Error("Model calls forbidden")));
  const config = HarnessConfigSchema.parse({});
  const createRuntime = vi.fn((_config: unknown, _overrides?: RuntimeOverrides) => ({
    store,
    sandboxBackend: {
      exec: () => Promise.reject(new Error("Sandbox is not used by context tests.")),
    },
    vault: new AuditingVaultResolver(new InMemoryVault(), () => undefined),
    keys: {
      currentKeyId: () => "fake",
      getKey: () => Promise.resolve(new Uint8Array(32)),
    },
    close,
    clock: { now: () => 0 },
    ids: { next: () => runId },
    run: modelCall,
    start: () => ({
      runId: Id.parse(runId),
      started: Promise.resolve(),
      completion: modelCall(),
    }),
    continueRun: modelCall,
    resume: modelCall,
    cancel: modelCall,
    resolveApproval: () => Promise.reject(new Error("Approval is not used by context tests.")),
    hasPendingApproval: () => Promise.resolve(false),
    tokenizeAppContent: (_runId: Id, content: JsonValue) => Promise.resolve(content),
    onAppContent: () => Promise.resolve(),
  }));
  const context: CliContext = {
    loadConfig: () => Promise.resolve(config),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
    createRuntime,
  };
  return { store, stdout, stderr, append, close, modelCall, createRuntime, context, config };
}

describe("harness context", () => {
  it("prints metadata without messages, summaries, arguments, or previews", async () => {
    const test = await harness();
    expect(await main(["context", runId], test.context)).toBe(0);
    const output = test.stdout.join("");
    expect(output).toMatch(/^Strategy: naive v\d+/mu);
    expect(output).toContain("Messages: 5");
    expect(output).toContain("Estimated tokens:");
    expect(output).toContain("Groups: 4 retained, 0 dropped");
    expect(output).toContain("Compacted ranges: 2-2");
    expect(output).toContain(`Offloaded handles: ${handle} (10000 bytes)`);
    expect(output).toContain("Pinned sequences: 1, 2");
    expect(output).toContain(handle);
    expect(output).not.toContain("{");
    expect(output).not.toContain("tokenized");
    expect(output).not.toContain("<EMAIL");
    expect(test.stderr.join("")).not.toMatch(/^\s*\{/mu);
    expect(test.append).not.toHaveBeenCalled();
    expect(test.modelCall).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it.each(["naive", "sliding_window", "summarizing"])(
    "rebuilds %s as one metadata-only JSON document without side effects",
    async (strategy) => {
      const test = await harness();
      expect(
        await main(
          [
            "context",
            runId,
            "--strategy",
            strategy,
            "--json",
            "--max-tokens",
            "200",
            "--reserve-output",
            "20",
            "--model",
            "test/offline",
          ],
          test.context,
          [contextCommand],
        ),
      ).toBe(0);
      expect(test.stdout).toHaveLength(1);
      expect(test.stderr).toEqual([]);
      const result = parseJson(ContextInspectionSchema, test.stdout.join(""));
      expect(result).toMatchObject({
        runId,
        strategy,
        model: { provider: "test", model: "offline" },
        maxTokens: 200,
        reserveOutputTokens: 20,
        messageCount: 5,
        groupCount: 4,
        retainedGroups: 4,
        droppedGroups: 0,
        compactedRanges: [{ fromSeq: 2, toSeq: 2 }],
        offloadedHandles: [{ handle, bytes: 10_000 }],
        pinnedSeqs: [1, 2],
      });
      expect(result.messages).toBeUndefined();
      expect(test.stderr.join("")).not.toContain("tokenized");
      expect(test.stderr.join("")).not.toMatch(/^\s*\{/mu);
      expect(test.append).not.toHaveBeenCalled();
      expect(test.modelCall).not.toHaveBeenCalled();
      expect(test.close).toHaveBeenCalledOnce();
      const override = test.createRuntime.mock.calls[0]?.[1];
      expect(override?.readOnlyStore).toBe(true);
      await expect(
        override?.model?.complete(
          {
            requestId: runId,
            model: { provider: "test", model: "offline" },
            messages: [],
          },
          { runId, signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({
        code: "context_model_call_forbidden",
      });
    },
  );

  it.each([false, true])("gates content and warns with JSON mode %s", async (json) => {
    const test = await harness();
    expect(
      await main(["context", runId, "--show-content", ...(json ? ["--json"] : [])], test.context, [
        contextCommand,
      ]),
    ).toBe(0);
    expect(test.stdout.join("")).toContain("<EMAIL_1>");
    expect(test.stdout.join("")).toContain("tokenized_summary");
    expect(test.stdout.join("")).not.toContain("old_tokenized_text");
    expect(test.stderr[0]).toBe("content_may_be_sensitive\n");
    expect(test.append).not.toHaveBeenCalled();
  });

  it("lists safe registered strategy identifiers for an unknown strategy", async () => {
    const test = await harness();
    expect(await main(["context", runId, "--strategy", "<EMAIL_1>"], test.context)).toBe(2);
    expect(test.stderr).toEqual([
      "available_strategies\n",
      "naive\n",
      "sliding_window\n",
      "summarizing\n",
      "usage\n",
    ]);
    expect(test.stdout).toEqual([]);
    expect(test.createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["--max-tokens", "-1"],
    ["--max-tokens", "1.5"],
    ["--max-tokens", "Infinity"],
    ["--max-tokens", "9007199254740992"],
    ["--reserve-output", "oops"],
    ["--model", "test"],
    ["--model", "test/model/extra"],
    ["--model", "Test/model"],
  ])("rejects invalid %s %s without echoing input", async (flag, value) => {
    const test = await harness();
    expect(await main(["context", runId, flag, value], test.context)).toBe(2);
    expect(test.stdout).toEqual([]);
    expect(test.stderr).toEqual(["usage\n"]);
    expect(test.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects invalid run IDs", async () => {
    const test = await harness();
    expect(await main(["context", "invalid"], test.context)).toBe(2);
    expect(test.stderr).toEqual(["usage\n"]);
  });

  it("closes the runtime for missing runs and strategy failures", async () => {
    const test = await harness();
    expect(await main(["context", "11111111111111111111111111"], test.context)).toBe(1);
    expect(test.stderr).toEqual(["run_not_found\n"]);
    expect(
      await main(
        ["context", runId, "--strategy", "summarizing", "--max-tokens", "0"],
        test.context,
      ),
    ).toBe(1);
    expect(test.close).toHaveBeenCalledTimes(2);
    expect(test.append).not.toHaveBeenCalled();
  });

  it("uses the configured default model for offline estimates", async () => {
    const test = await harness();
    test.config.models.routing.default.push({ provider: "test", model: "configured" });
    expect(await main(["context", runId, "--json"], test.context)).toBe(0);
    expect(parseJson(ContextInspectionSchema, test.stdout.join("")).model).toEqual({
      provider: "test",
      model: "configured",
    });
  });

  it("reports dropped groups while preserving pins and atomic tool groups", async () => {
    const test = await harness();
    expect(
      await main(
        [
          "context",
          runId,
          "--strategy",
          "sliding_window",
          "--max-tokens",
          "45",
          "--reserve-output",
          "0",
          "--json",
        ],
        test.context,
      ),
    ).toBe(0);
    const result = parseJson(ContextInspectionSchema, test.stdout.join(""));
    expect(result.droppedGroups).toBeGreaterThan(0);
    expect(result.retainedGroups + result.droppedGroups).toBe(result.groupCount);
    expect(result.offloadedHandles).toEqual([]);
    expect(result.pinnedSeqs).toEqual([1, 2]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(45);
    expect(test.append).not.toHaveBeenCalled();
  });

  it("prints a metadata-only strategy comparison table", async () => {
    const test = await harness();
    const exitCode = await main(
      [
        "context",
        runId,
        "--compare",
        "naive,sliding_window",
        "--max-tokens",
        "45",
        "--reserve-output",
        "0",
        "--json",
      ],
      test.context,
      [contextCommand],
    );
    expect(exitCode).toBe(0);
    const report = parseJson(StrategyComparisonReportSchema, test.stdout.join(""));
    expect(report.comparisons.map(({ strategy }) => strategy)).toEqual(["naive", "sliding_window"]);
    expect(report.coverage).toHaveLength(2);
    expect(report.coverage.map(({ retainedSeqCoverage }) => retainedSeqCoverage)).toEqual([1, 0.4]);
    expect(report.comparisons[0]?.retainedSeqs).toEqual(
      [1, 2, 4, 5, 6].map((seq) => ({ runId, seq })),
    );
    expect(report.comparisons[1]?.droppedGroups).toBeGreaterThan(0);
    expect(test.stderr).toEqual([]);
    expect(test.append).not.toHaveBeenCalled();
    expect(test.modelCall).not.toHaveBeenCalled();
  });

  it("compares naive and summarizing offline using recorded compaction events", async () => {
    const test = await harness();
    expect(
      await main(["context", runId, "--compare", "naive,summarizing", "--json"], test.context, [
        contextCommand,
      ]),
    ).toBe(0);
    const report = parseJson(StrategyComparisonReportSchema, test.stdout.join(""));

    expect(report.comparisons.map(({ strategy }) => strategy)).toEqual(["naive", "summarizing"]);
    expect(report.comparisons[1]?.compactedRanges).toEqual([{ fromSeq: 2, toSeq: 2 }]);
    expect(report.comparisons[1]?.retainedSeqs).toContainEqual({ runId, seq: 2 });
    expect(test.modelCall).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });

  it("snapshots the human-readable comparison table", async () => {
    const test = await harness();
    const exitCode = await main(
      [
        "context",
        runId,
        "--compare",
        "naive,sliding_window",
        "--max-tokens",
        "45",
        "--reserve-output",
        "0",
      ],
      test.context,
      [contextCommand],
    );
    expect(exitCode).toBe(0);

    expect(test.stdout.join("")).toBe(
      [
        [
          "Strategy",
          "Version",
          "Tokens",
          "Messages",
          "Dropped",
          "Compacted ranges",
          "Retained refs",
          "Coverage",
        ].join("\t"),
        [
          "naive",
          "v6",
          "101",
          "5",
          "0",
          "2-2",
          [1, 2, 4, 5, 6].map((seq) => `${runId}:${String(seq)}`).join(", "),
          "100.0% covered",
        ].join("\t"),
        [
          "sliding_window",
          "v4",
          "42",
          "3",
          "2",
          "2-2",
          [1, 2].map((seq) => `${runId}:${String(seq)}`).join(", "),
          "40.0% covered",
        ].join("\t"),
        "",
      ].join("\n"),
    );
  });

  it("inspects SQLite without initialization writes or creating missing storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-read-only-"));
    try {
      const test = await harness();
      const path = join(directory, "harness.db");
      const store = new SqliteEventStore(path);
      const events = [];
      for await (const stored of test.store.read(runId)) {
        events.push(stored);
      }
      await store.append(
        runId,
        events.map(({ seq: _seq, ...value }) => value),
        0,
      );
      await store.close();
      const before = await readFile(path);
      const filesBefore = (await readdir(directory)).sort();
      test.context.createRuntime = (config, overrides) =>
        composeRuntime(config, { ...overrides, dataDir: directory });
      expect(await main(["context", runId, "--json"], test.context)).toBe(0);
      expect(await readFile(path)).toEqual(before);
      expect((await readdir(directory)).sort()).toEqual(filesBefore);
      test.context.createRuntime = (config, overrides) =>
        composeRuntime(config, { ...overrides, dataDir: join(directory, "missing") });
      expect(await main(["context", runId], test.context)).toBe(1);
      expect(existsSync(join(directory, "missing"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
