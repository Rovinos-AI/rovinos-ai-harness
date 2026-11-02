// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id, SequentialIdGenerator, EventSchema } from "@rovinos/schemas";
import type { Event, ModelRequest } from "@rovinos/schemas";
import { AdapterRegistry, ModelGateway } from "@rovinos/models";
import type { ProviderAdapter } from "@rovinos/models";
import { describe, expect, it } from "vitest";
import { LlmJudgeGraderSpecSchema } from "../schema.js";
import { completedTrialResult } from "../../test-utils/trial-result.js";
import type { GradeContext } from "./types.js";
import { buildJudgeView, createJudgeVerdictSchema, createLlmJudgeGrader } from "./llm-judge.js";

const runId = Id.parse("00000000000000000000000001");
const rubric =
  "- id: accuracy\n  description: The answer is accurate.\n  weight: 3\n- id: style\n  description: The answer is concise.\n  weight: 1";

function envelope(seq: number) {
  return {
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    segmentId: runId,
  };
}

function events(): Event[] {
  const callId = Id.parse("00000000000000000000000002");
  return [
    EventSchema.parse({
      ...envelope(1),
      type: "run_input",
      input: { goal: "Summarize <EMAIL_1>" },
      inputKind: "initial",
    }),
    EventSchema.parse({
      ...envelope(2),
      type: "tool_intent",
      callId,
      toolId: "lookup",
      idempotent: true,
      policyDecision: "allow",
      argsHash: "a".repeat(64),
      args: {},
    }),
    EventSchema.parse({
      ...envelope(3),
      type: "tool_result",
      callId,
      toolId: "lookup",
      outcome: "ok",
      latencyMs: 1,
      result: { contact: "<EMAIL_1>", text: "x".repeat(600) },
    }),
    EventSchema.parse({
      ...envelope(4),
      type: "model_response",
      requestId: callId,
      provider: "openai",
      model: "fixture",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "stop",
      latencyMs: 1,
      schemaValid: true,
      repairAttempts: 0,
      content: [{ type: "text", text: "The result is <EMAIL_1>." }],
      providerBlobs: null,
    }),
    EventSchema.parse({
      ...envelope(5),
      type: "run_status_changed",
      from: "running",
      to: "completed",
      reason: "finished",
    }),
  ];
}

function context(trialEvents: readonly Event[] = events()): GradeContext {
  return {
    result: completedTrialResult({
      runId,
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
    }),
    events: trialEvents,
  };
}

function gateway(outputs: readonly string[], options: { maxRepairs?: number } = {}) {
  const requests: ModelRequest[] = [];
  const outputQueue = [...outputs];
  const adapter: ProviderAdapter = {
    provider: "openai",
    kind: "openai",
    complete(request) {
      requests.push(request);
      return Promise.resolve({
        parts: [{ type: "text", text: outputQueue.shift() ?? "" }],
        usage: { inputTokens: 4, outputTokens: 2, costMicros: 7 },
        finishReason: "stop",
        latencyMs: 1,
      });
    },
  };
  return {
    requests,
    gateway: new ModelGateway(new AdapterRegistry([adapter]), {
      ids: new SequentialIdGenerator(),
      clock: new FakeClock(1),
      enforcement: { maxRepairs: options.maxRepairs ?? 2 },
      pricing: {
        "openai/fixture": {
          inputMicrosPerMTok: 1_000_000,
          outputMicrosPerMTok: 1_500_000,
        },
      },
    }),
  };
}

function spec(votes?: 3) {
  return LlmJudgeGraderSpecSchema.parse({
    type: "llm_judge",
    rubricId: "answer_quality",
    rubric,
    model: { provider: "openai", model: "fixture" },
    passThreshold: 0.75,
    ...(votes === undefined ? {} : { votes }),
  });
}

const metBoth = JSON.stringify({
  criteria: [
    { id: "accuracy", met: true },
    { id: "style", met: true },
  ],
  verdict: "pass",
});

describe("createLlmJudgeGrader", () => {
  it("uses a schema-enforced verdict and returns the weighted score and judge usage", async () => {
    const fake = gateway([
      JSON.stringify({
        criteria: [
          { id: "accuracy", met: true },
          { id: "style", met: false },
        ],
        verdict: "pass",
      }),
    ]);
    const result = await createLlmJudgeGrader(spec(), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    }).grade(context());

    expect(result).toMatchObject({
      graderId: "llm_judge",
      pass: true,
      score: 0.75,
      codes: [],
      usage: { inputTokens: 4, outputTokens: 2, costMicros: 7 },
    });
    expect(fake.requests[0]?.temperature).toBe(0);
    expect(fake.requests[0]?.output?.schema).toMatchObject({
      properties: {
        criteria: {
          items: {
            properties: { id: { enum: ["accuracy", "style"] } },
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("The answer is accurate.");
  });

  it("returns judge_error when structured output remains invalid after gateway repair", async () => {
    const fake = gateway(['{"criteria":[],"verdict":"pass"}'], { maxRepairs: 0 });
    const result = await createLlmJudgeGrader(spec(), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    }).grade(context());

    expect(result).toMatchObject({
      pass: false,
      score: 0,
      codes: ["judge_error"],
      counts: { judge_error: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("criteria");
  });

  it.each([
    [
      "missing",
      JSON.stringify({
        criteria: [{ id: "accuracy", met: true }],
        verdict: "pass",
      }),
    ],
    [
      "extra",
      JSON.stringify({
        criteria: [
          { id: "accuracy", met: true },
          { id: "unexpected", met: false },
        ],
        verdict: "pass",
      }),
    ],
  ])("repairs %s criterion ids with the shared verdict schema", async (_label, invalid) => {
    const fake = gateway([invalid, metBoth], { maxRepairs: 1 });
    const result = await createLlmJudgeGrader(spec(), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    }).grade(context());

    expect(result).toMatchObject({
      pass: true,
      usage: { inputTokens: 8, outputTokens: 4, costMicros: 14 },
    });
    expect(fake.requests).toHaveLength(2);
  });

  it("requires both a majority pass verdict and the weighted score threshold", async () => {
    const fake = gateway([
      JSON.stringify({
        criteria: [
          { id: "accuracy", met: true },
          { id: "style", met: true },
        ],
        verdict: "fail",
      }),
    ]);
    const result = await createLlmJudgeGrader(spec(), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    }).grade(context());

    expect(result).toMatchObject({ pass: false, score: 1 });
  });

  it("uses per-criterion and verdict majorities for three votes", async () => {
    const fake = gateway([
      metBoth,
      metBoth,
      JSON.stringify({
        criteria: [
          { id: "accuracy", met: false },
          { id: "style", met: false },
        ],
        verdict: "fail",
      }),
    ]);
    const result = await createLlmJudgeGrader(spec(3), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    }).grade(context());

    expect(result).toMatchObject({
      pass: true,
      score: 1,
      counts: { votes_total: 3, votes_pass: 2 },
      usage: { inputTokens: 12, outputTokens: 6, costMicros: 21 },
    });
  });

  it("builds a bounded view from tokenized events only", () => {
    const view = buildJudgeView(events(), context().result);

    expect(view).toMatchObject({
      goal: "Summarize <EMAIL_1>",
      finalAnswer: "The result is <EMAIL_1>.",
      runStatus: "completed",
    });
    expect(view.toolCalls[0]?.result).toHaveLength(500);
    expect(JSON.stringify(view)).not.toContain("alice@example.test");
    expect(JSON.stringify(view)).not.toContain("/synthetic/run.db");
  });

  it("builds a strict verdict schema with no reasoning field", () => {
    const schema = createJudgeVerdictSchema([
      { id: "accuracy", description: "Accurate.", weight: 1 },
      { id: "style", description: "Concise.", weight: 1 },
    ]);

    expect(schema.safeParse(JSON.parse(metBoth)).success).toBe(true);
    expect(
      schema.safeParse({
        criteria: [{ id: "other", met: true }],
        verdict: "pass",
        reasoning: "not retained",
      }).success,
    ).toBe(false);
  });

  it("fails safely when trial events or run identity are unavailable", async () => {
    const fake = gateway([]);
    const grader = createLlmJudgeGrader(spec(), {
      gateway: fake.gateway,
      ids: new SequentialIdGenerator(),
    });
    const missingEvents = await grader.grade({ result: context().result });
    const missingRunId = await grader.grade({
      result: completedTrialResult({
        dbPath: "/synthetic/run.db",
        workspaceDir: "/synthetic/workspace",
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
      }),
      events: [],
    });

    expect(missingEvents.codes).toEqual(["judge_error"]);
    expect(missingRunId.codes).toEqual(["judge_error"]);
    expect(fake.requests).toHaveLength(0);
  });
});
