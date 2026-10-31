// SPDX-License-Identifier: Apache-2.0
// Replay constructs cassette-only adapters before any live credentials are resolved.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createConfiguredModelPort } from "@rovinos/core";
import { CassetteProvider, FileCassetteStore, requestHash } from "@rovinos/models";
import type { ProviderAdapter } from "@rovinos/models";
import {
  FakeClock,
  ModelUsageSchema,
  SequentialIdGenerator,
  parseJson,
  parseYaml,
} from "@rovinos/schemas";
import type { ModelUsage } from "@rovinos/schemas";
import type { Grader, LlmJudgeGraderSpec, TrialSpec } from "@rovinos/eval";
import type { EvalPackage } from "./eval-types.js";
import type { EvalExecutorOptions } from "./eval-executor.js";

function judgeHash(rubricId: string, requestId: string, hash: string): string {
  return createHash("sha256").update(`${rubricId}:${requestId}:${hash}`).digest("hex");
}

function recordAdapter(
  adapter: ProviderAdapter,
  fileStore: FileCassetteStore,
  verdictSchema: ReturnType<EvalPackage["createJudgeVerdictSchema"]>,
  rubricId: string,
): ProviderAdapter {
  let originalHash: string | undefined;
  let usage: ModelUsage | undefined;
  let latencyMs = 0;
  return {
    provider: adapter.provider,
    kind: "cassette",
    complete: async (request, context) => {
      originalHash ??= judgeHash(rubricId, request.requestId, requestHash(request));
      const response = await adapter.complete(request, context);
      usage = ModelUsageSchema.parse(
        Object.fromEntries(
          (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const).flatMap(
            (field) =>
              usage?.[field] === undefined && response.usage[field] === undefined
                ? []
                : [[field, (usage?.[field] ?? 0) + (response.usage[field] ?? 0)]],
          ),
        ),
      );
      latencyMs += response.latencyMs;
      let verdict;
      try {
        const text = response.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        verdict = parseJson(verdictSchema, text);
      } catch {
        // Invalid output stays in flight for gateway repair and cost accounting, never on disk.
        return response;
      }
      const sanitized = {
        ...response,
        parts: [{ type: "text" as const, text: JSON.stringify(verdict) }],
      };
      // Replay the logical vote without persisting the malformed repair transcript.
      await fileStore.set({
        hash: originalHash,
        response: { ...sanitized, usage, latencyMs },
      });
      originalHash = undefined;
      usage = undefined;
      latencyMs = 0;
      return sanitized;
    },
  };
}

/** Builds a trial-scoped judge through the same configured gateway as the runtime. */
export async function judgeGrader(
  api: EvalPackage,
  spec: LlmJudgeGraderSpec,
  trial: TrialSpec,
  environment: {
    readonly options: EvalExecutorOptions;
    readonly stores: Map<string, FileCassetteStore>;
  },
): Promise<Grader> {
  const { options, stores } = environment;
  const mode = trial.variant.cassetteMode ?? options.cassette;
  const path = join(
    options.suiteDirectory,
    "cassettes",
    trial.task.id,
    `${trial.variantId}.judge.json`,
  );
  let store = stores.get(path);
  if (store === undefined) {
    store = new FileCassetteStore(path);
    stores.set(path, store);
  }
  const fileStore = store;
  const verdictSchema = api.createJudgeVerdictSchema(parseYaml(api.JudgeRubricSchema, spec.rubric));
  // Vote identity is part of the cassette key, preserving disagreeing majority votes.
  const replay = new CassetteProvider("replay", {
    get: (hash, request) =>
      fileStore.get(judgeHash(spec.rubricId, request.requestId, hash), request),
    set: (entry) => fileStore.set(entry),
  });
  const ids = new SequentialIdGenerator();
  const gateway = await createConfiguredModelPort(
    {
      ...options.config.models,
      ...(mode === "replay" ? { providers: [] } : {}),
      routing: {
        ...options.config.models.routing,
        default: [spec.model],
        roles: { judge: [spec.model] },
      },
    },
    {
      ids,
      clock: new FakeClock(1_700_000_000_000 + trial.seed),
      ...(mode === "replay"
        ? {
            providerAdapters: [
              {
                provider: spec.model.provider,
                kind: "cassette",
                complete: (request, context) => replay.complete(request, context),
              },
            ],
          }
        : {
            ...(options.context.secretResolver === undefined
              ? {}
              : { secretResolver: options.context.secretResolver }),
            ...(mode === "record"
              ? {
                  decorateAdapter: (adapter: ProviderAdapter) =>
                    recordAdapter(adapter, fileStore, verdictSchema, spec.rubricId),
                }
              : {}),
          }),
    },
  );
  if (gateway === undefined) {
    throw new Error("eval_llm_judge_gateway_unavailable");
  }
  return api.createLlmJudgeGrader(spec, { gateway, ids });
}
