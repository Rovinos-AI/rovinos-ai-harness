// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, Id } from "../primitives.js";
import { JsonValue } from "../json.js";
import { RunStatus } from "../events.js";

/** User input for starting one run from the CLI. */
export const RunInputSchema = z
  .object({
    goal: z.string().min(1),
    metadata: z.record(Code, z.union([Code, z.number(), z.boolean()])).optional(),
  })
  .strict();

export type RunInput = z.infer<typeof RunInputSchema>;

/** Machine-readable result returned by `harness run` and `harness resume`. */
export const RunResultSchema = z
  .object({
    runId: Id,
    status: RunStatus,
  })
  .strict();

export type RunResult = z.infer<typeof RunResultSchema>;

/** The model completion entries accepted by the local fake-model script. */
export const FakeModelCompletionSchema = z
  .object({
    content: JsonValue,
    toolCalls: z
      .array(
        z
          .object({
            callId: Id,
            toolId: Code,
            args: JsonValue,
          })
          .strict(),
      )
      .default([]),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().default(0),
        outputTokens: z.number().int().nonnegative().default(0),
        costMicros: z.number().int().nonnegative().optional(),
      })
      .strict()
      .prefault({}),
    finishReason: Code.default("stop"),
    provider: Code.default("fake"),
    model: Code.default("script"),
    latencyMs: z.number().int().nonnegative().default(0),
    schemaValid: z.boolean().default(true),
    repairAttempts: z.number().int().nonnegative().default(0),
    providerBlobs: JsonValue.default(null),
  })
  .strict();

/** Script file format accepted by `harness run --fake-model`. */
export const FakeModelScriptSchema = z.array(FakeModelCompletionSchema);

export type FakeModelScript = z.infer<typeof FakeModelScriptSchema>;

/** A validated scripted model completion. */
export type FakeModelCompletion = z.infer<typeof FakeModelCompletionSchema>;
