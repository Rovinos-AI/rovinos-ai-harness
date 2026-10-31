// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { Event } from "@rovinos/schemas";
import type { ModelPort } from "@rovinos/core";
import type { EvalPackage, TrialSpec } from "./eval-types.js";

/** Creates a model port that replays responses from the suite cassette directory. */
export function cassetteModelFactory(suiteDirectory: string): (trial: TrialSpec) => ModelPort {
  return (trial) => {
    const path = join(
      suiteDirectory,
      "cassettes",
      trial.task.id,
      `${trial.variantId}.json`,
    );
    return {
      async complete(request) {
        const { CassetteMissError, FileCassetteStore } = await import("@rovinos/models");
        const { modelRequestParametersHash, storedModelRequestHash } = await import(
          "@rovinos/schemas/request-signature"
        );
        const hash = storedModelRequestHash(request.messages, modelRequestParametersHash(request));
        const store = new FileCassetteStore(path);
        const response = await store.get(hash, request);
        if (response === undefined) {
          throw new CassetteMissError(hash);
        }
        return {
          ...response,
          provider: request.model.provider,
          model: request.model.model,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        };
      },
    };
  };
}

function trialIdentity(record: {
  readonly taskId: string;
  readonly variantId: string;
  readonly trialIndex: number;
}): string {
  return `${record.taskId}\u0000${record.variantId}\u0000${String(record.trialIndex)}`;
}

/** Writes tokenized model request and response events to cassette files. */
export async function recordCassettes(
  suiteDirectory: string,
  records: ReturnType<EvalPackage["parseEvalTrialJsonl"]>,
  eventsByTrial: ReadonlyMap<string, readonly Event[]>,
): Promise<void> {
  const { FileCassetteStore } = await import("@rovinos/models");
  const stores = new Map<string, InstanceType<typeof FileCassetteStore>>();
  for (const record of records) {
    if (record.result.status === "skipped_budget") {
      continue;
    }
    const taskEvents = eventsByTrial.get(trialIdentity(record)) ?? [];
    const responses = new Map(
      taskEvents
        .filter((event) => event.type === "model_response")
        .map((event) => [event.requestId, event]),
    );
    const path = join(suiteDirectory, "cassettes", record.taskId, `${record.variantId}.json`);
    let store = stores.get(path);
    if (store === undefined) {
      store = new FileCassetteStore(path);
      stores.set(path, store);
    }
    for (const request of taskEvents) {
      if (request.type !== "model_request" || request.requestHash === undefined) {
        continue;
      }
      const response = responses.get(request.requestId);
      if (response === undefined) {
        continue;
      }
      await store.set({
        hash: request.requestHash,
        response: {
          parts: response.content,
          usage: {
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            ...(response.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: response.cacheReadTokens }),
            ...(response.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: response.cacheWriteTokens }),
            ...(response.costMicros === undefined ? {} : { costMicros: response.costMicros }),
          },
          finishReason: response.finishReason,
          latencyMs: response.latencyMs,
        },
      });
    }
  }
}
