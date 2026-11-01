// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventSchema, Id, parseJson } from "@rovinos/schemas";
import type { Event } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { RedTeamCassetteSchema, suite } from "../../../evals/redteam/suite.js";
import { verifyInvariants } from "./invariants.js";

const cassettePath = fileURLToPath(
  new URL("../../../evals/redteam/cassettes/attacks.json", import.meta.url),
);

function cassetteEvents(): readonly Event[] {
  const runId = Id.parse("00000000000000000000000001");
  return [
    EventSchema.parse({
      runId,
      seq: 0,
      ts: 1,
      v: 1,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      segmentId: runId,
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "policy_test",
      requestedBy: "cli.requester",
    }),
    EventSchema.parse({
      runId,
      seq: 1,
      ts: 2,
      v: 1,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      segmentId: runId,
      type: "input_requested",
      requestId: Id.parse("00000000000000000000000002"),
      source: "agent",
      round: 0,
      mode: "form",
      message: "Synthetic human-input test.",
    }),
    EventSchema.parse({
      runId,
      seq: 2,
      ts: 3,
      v: 1,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      segmentId: runId,
      type: "input_resolved",
      requestId: Id.parse("00000000000000000000000002"),
      source: "agent",
      mode: "form",
      round: 0,
      action: "accept",
      decidedBy: "policy",
      waitMs: 1,
    }),
  ];
}

describe("red-team cassette replay", () => {
  it("validates the scripted cases against the eval suite and replays without a provider", async () => {
    const cassette = parseJson(RedTeamCassetteSchema, await readFile(cassettePath, "utf8"));
    const tasks = new Map(suite.tasks.map((task) => [task.id, task]));

    expect(suite.invariants).toBe(true);
    expect(cassette.cases).toHaveLength(12);
    for (const testCase of cassette.cases) {
      const task = tasks.get(testCase.taskId);
      expect(task).toBeDefined();
      expect(task?.graders.map(({ type }) => type)).toEqual([
        "approval_integrity",
        "no_denied_executed",
        "trajectory",
      ]);
      expect(task?.graders[2]).toMatchObject({
        type: "trajectory",
        assertions: [
          { type: "final_status", status: testCase.expectedStatus },
          { type: "tool_never_executed", toolId: testCase.forbiddenTool },
        ],
      });
    }

    expect(verifyInvariants(cassetteEvents())).toEqual([{ code: "input_resolution_not_human" }]);
  });
});
