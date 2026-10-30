// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id, SequentialIdGenerator } from "@rovinos/schemas";
import {
  AdapterRegistry,
  CassetteProvider,
  ModelGateway,
  type CassetteEntry,
  type CassetteStore,
  type ProviderAdapter,
  type ProviderResult,
} from "@rovinos/models";
import { describe, expect, it } from "vitest";
import { LlmJudgeGraderSpecSchema } from "../schema.js";
import type { GradeContext } from "./types.js";
import { createLlmJudgeGrader } from "./llm-judge.js";

const runId = Id.parse("00000000000000000000000001");
const rubric = "- id: accuracy\n  description: Accurate.\n  weight: 1";

describe("LLM judge cassette replay", () => {
  it("replays the same schema-enforced verdict without calling the live provider", async () => {
    const entries = new Map<string, CassetteEntry>();
    const store: CassetteStore = {
      get(hash) {
        return Promise.resolve(entries.get(hash)?.response);
      },
      set(entry) {
        entries.set(entry.hash, entry);
        return Promise.resolve();
      },
    };
    let liveCalls = 0;
    const inner: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      complete(): Promise<ProviderResult> {
        liveCalls += 1;
        return Promise.resolve({
          parts: [
            {
              type: "text",
              text: JSON.stringify({
                criteria: [{ id: "accuracy", met: true }],
                verdict: "pass",
              }),
            },
          ],
          usage: { inputTokens: 2, outputTokens: 2 },
          finishReason: "stop",
          latencyMs: 1,
        });
      },
    };
    const privacy = {
      sanitize: (response: ProviderResult) => Promise.resolve(response),
      detectRealData: () => Promise.resolve(false),
    };
    const context: GradeContext = {
      result: {
        status: "completed",
        runId,
        dbPath: "/synthetic/run.db",
        workspaceDir: "/synthetic/workspace",
        durationMs: 1,
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      },
      events: [],
    };
    const spec = LlmJudgeGraderSpecSchema.parse({
      type: "llm_judge",
      rubricId: "accuracy",
      rubric,
      model: { provider: "cassette", model: "fixture" },
      passThreshold: 1,
    });

    async function grade(mode: "record" | "replay") {
      const cassette =
        mode === "record"
          ? new CassetteProvider(mode, store, inner, privacy)
          : new CassetteProvider(mode, store);
      const gateway = new ModelGateway(new AdapterRegistry([cassette]), {
        ids: new SequentialIdGenerator(),
        clock: new FakeClock(1),
      });
      return createLlmJudgeGrader(spec, {
        gateway,
        ids: new SequentialIdGenerator(),
      }).grade(context);
    }

    const recorded = await grade("record");
    const replayed = await grade("replay");

    expect(replayed).toEqual(recorded);
    expect(replayed.pass).toBe(true);
    expect(liveCalls).toBe(1);
  });
});
