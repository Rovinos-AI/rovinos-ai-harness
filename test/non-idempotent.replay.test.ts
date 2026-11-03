// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, Event, Id, Sha256Hex, type JsonValue } from "@rovinos/schemas";
import type { ToolPort } from "@rovinos/core";
import { ReplayToolPort, ResolvedRunSchema } from "@rovinos/replay";
import { describe, expect, it } from "vitest";

const runId = Id.parse("00000000000000000000000071");
const replayRunId = Id.parse("00000000000000000000000072");
const callId = Id.parse("00000000000000000000000073");
const toolId = Code.parse("synthetic.non_idempotent");
const args: JsonValue = {};
const argsHash = Sha256Hex.parse(createHash("sha256").update("{}").digest("hex"));
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

describe("non-idempotent tool replay", () => {
  it("serves the recorded result without repeating the external effect", async () => {
    let effectCount = 0;
    const tool: ToolPort = {
      describe: (id) => (id === toolId ? { idempotent: false, timeoutMs: 1_000 } : undefined),
      execute: () => {
        effectCount += 1;
        return Promise.resolve({ outcome: "ok", result: { completed: true } });
      },
    };
    const call = { callId, toolId, args };
    await tool.execute(call, { runId, signal: new AbortController().signal });
    const resolved = ResolvedRunSchema.parse({
      rootRunId: runId,
      runs: [
        {
          runId,
          role: "root",
          events: [
            Event.parse({
              runId,
              seq: 0,
              ts: 1,
              v: 1,
              traceId,
              spanId,
              segmentId: runId,
              type: "run_created",
              configHash: "c".repeat(64),
              policyVersion: "synthetic.policy",
            }),
            Event.parse({
              runId,
              seq: 1,
              ts: 2,
              v: 1,
              traceId,
              spanId,
              segmentId: runId,
              type: "tool_intent",
              callId,
              toolId,
              idempotent: false,
              policyDecision: "allow",
              argsHash,
              args,
            }),
            Event.parse({
              runId,
              seq: 2,
              ts: 3,
              v: 1,
              traceId,
              spanId,
              segmentId: runId,
              type: "tool_result",
              callId,
              toolId,
              outcome: "ok",
              latencyMs: 1,
              executedArgsHash: argsHash,
              result: { completed: true },
            }),
          ],
        },
      ],
    });
    const replay = new ReplayToolPort(resolved, tool, replayRunId, runId);

    await expect(
      replay.execute(call, { runId: replayRunId, signal: new AbortController().signal }),
    ).resolves.toEqual({ outcome: "ok", result: { completed: true } });
    expect(replay.describe(toolId, args)?.idempotent).toBe(false);
    expect(effectCount).toBe(1);
  });
});
