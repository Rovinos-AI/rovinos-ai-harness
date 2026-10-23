// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { defineSuite } from "./load.js";
import { EvalVariantSchema, TrialResultSchema, TrialSpecSchema } from "./trial.js";

const suite = defineSuite({
  schemaVersion: 1,
  tasks: [{ id: "task_one", input: { goal: "A synthetic goal." }, graders: [], tags: [] }],
});
const variant = EvalVariantSchema.parse({ id: "baseline", cassetteMode: "replay" });

describe("eval trial contracts", () => {
  it("accepts a task/variant trial with its deterministic seed", () => {
    expect(
      TrialSpecSchema.parse({
        suite,
        task: suite.tasks[0],
        variantId: variant.id,
        variant,
        trialIndex: 0,
        seed: 42,
        workDir: "/tmp/eval-trial",
      }),
    ).toMatchObject({ variantId: "baseline", trialIndex: 0, seed: 42 });
  });

  it("rejects mismatched variants and malformed cassette modes", () => {
    expect(
      TrialSpecSchema.safeParse({
        suite,
        task: suite.tasks[0],
        variantId: "other",
        variant,
        trialIndex: 0,
        seed: 42,
        workDir: "/tmp/eval-trial",
      }).success,
    ).toBe(false);
    expect(EvalVariantSchema.safeParse({ id: "baseline", cassetteMode: "unknown" }).success).toBe(
      false,
    );
  });

  it("requires a code for errors and accepts metadata-only results", () => {
    const fields = {
      dbPath: "/tmp/eval-trial/data/harness.db",
      workspaceDir: "/tmp/eval-trial/workspace",
      durationMs: 1,
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
    };
    expect(TrialResultSchema.safeParse({ status: "error", ...fields }).success).toBe(false);
    expect(
      TrialResultSchema.parse({
        status: "completed",
        runId: Id.parse("00000000000000000000000001"),
        ...fields,
      }),
    ).toMatchObject({ status: "completed", usage: fields.usage });
  });
});
