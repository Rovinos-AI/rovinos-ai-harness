// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  Code,
  Event as EventSchema,
  Id,
  Sha256Hex,
  type Event,
  type JsonValue,
} from "@harness/schemas";
import type { ToolPort } from "@harness/core";
import { ResolvedRunSchema } from "../resolve.js";
import { describe, expect, it, vi } from "vitest";
import { ReplayDivergenceError } from "./replay-model.js";
import type { ReplayMissingResultError } from "./replay-model.js";
import { ReplayToolPort } from "./replay-tools.js";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const callId = Id.parse("00000000000000000000000003");
const args: JsonValue = { query: "synthetic" };
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(",")}}`;
}

function argsHash(value: JsonValue): string {
  return Sha256Hex.parse(createHash("sha256").update(canonical(value)).digest("hex"));
}

function fixture(includeResult = true) {
  const intent = EventSchema.parse({
    runId,
    seq: 1,
    ts: 2,
    v: 1,
    traceId,
    spanId,
    segmentId,
    type: "tool_intent",
    callId,
    toolId: "test.lookup",
    idempotent: true,
    policyDecision: "allow",
    argsHash: argsHash(args),
    args,
  });
  const events: Event[] = [
    EventSchema.parse({
      runId,
      seq: 0,
      ts: 1,
      v: 1,
      traceId,
      spanId,
      segmentId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
    }),
    intent,
  ];
  if (includeResult) {
    events.push(
      EventSchema.parse({
        runId,
        seq: 2,
        ts: 3,
        v: 1,
        traceId,
        spanId,
        segmentId,
        type: "tool_result",
        callId,
        toolId: "test.lookup",
        outcome: "ok",
        latencyMs: 1,
        executedArgsHash: argsHash(args),
        result: { found: true },
      }),
    );
  }
  const resolved = ResolvedRunSchema.parse({
    rootRunId: runId,
    runs: [{ runId, role: "root", events }],
  });
  return { resolved, intent };
}

describe("ReplayToolPort", () => {
  it("returns recorded metadata and result without executing a registered tool", async () => {
    const { resolved } = fixture();
    const execute = vi.fn();
    const registry: Pick<ToolPort, "describe" | "getToolSpecs" | "validateInputSchema"> = {
      describe: vi.fn(() => ({ idempotent: false, timeoutMs: 1234 })),
      getToolSpecs: vi.fn(() => []),
      validateInputSchema: vi.fn(() => Promise.resolve(true)),
    };
    const port = new ReplayToolPort(resolved, registry);
    const context = { runId, signal: new AbortController().signal };

    expect(port.describe(Code.parse("test.lookup"), args)).toEqual({
      idempotent: true,
      timeoutMs: 1234,
    });
    expect(port.describe(Code.parse("test.unknown"))).toBeUndefined();
    await expect(
      port.execute({ callId, toolId: Code.parse("test.lookup"), args }, context),
    ).resolves.toEqual({ outcome: "ok", result: { found: true } });
    expect(port.getToolSpecs()).toEqual([]);
    await expect(
      port.validateInputSchema(Code.parse("test.lookup"), args, {}, context),
    ).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("detects argument hash divergence without exposing either hash", async () => {
    const { resolved } = fixture();
    const port = new ReplayToolPort(resolved);

    const error = await port
      .execute(
        { callId, toolId: Code.parse("test.lookup"), args: { query: "changed" } },
        { runId, signal: new AbortController().signal },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplayDivergenceError);
    if (!(error instanceof ReplayDivergenceError)) {
      throw error;
    }
    expect(error).toMatchObject({
      code: "replay_divergence",
      seq: 1,
      hashMismatchCode: "tool_args_hash_mismatch",
    });
    expect("expectedHash" in error).toBe(false);
    expect("actualHash" in error).toBe(false);
  });

  it("reports an interrupted intent without a result", async () => {
    const { resolved } = fixture(false);
    const port = new ReplayToolPort(resolved);

    await expect(
      port.execute(
        { callId, toolId: Code.parse("test.lookup"), args },
        { runId, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "replay_missing_result",
      seq: 1,
    } satisfies Partial<ReplayMissingResultError>);
  });
});
