// SPDX-License-Identifier: Apache-2.0
import { ModelRefSchema, type Message, type ModelRef } from "@harness/schemas";
import { z } from "zod";
import type { TokenCounter } from "./types.js";

const DEFAULT_SAFETY_FACTOR = 1.15;
const CALIBRATION_ALPHA = 0.3;
const MIN_CALIBRATION_RATIO = 0.5;
const MAX_CALIBRATION_RATIO = 2;

const CalibrationSnapshotEntrySchema = z
  .object({
    model: ModelRefSchema,
    ratio: z.number().min(MIN_CALIBRATION_RATIO).max(MAX_CALIBRATION_RATIO),
  })
  .strict();

/** Validated per-model calibration values suitable for a context snapshot. */
export const CalibrationSnapshotSchema = z.array(CalibrationSnapshotEntrySchema);

/** Inferred calibration state persisted with a context snapshot. */
export type CalibrationSnapshot = z.infer<typeof CalibrationSnapshotSchema>;

/** Conservative character-based token estimate, replaceable by an exact tokenizer. */
export class HeuristicTokenCounter implements TokenCounter {
  private readonly safetyFactor: number;

  /**
   * Creates a heuristic counter with a configurable conservative margin.
   *
   * @param safetyFactor - Positive multiplier applied to the estimate; defaults to 1.15.
   */
  constructor(safetyFactor = DEFAULT_SAFETY_FACTOR) {
    this.safetyFactor = z.number().positive().parse(safetyFactor);
  }

  /** {@inheritDoc TokenCounter.count} */
  count(messages: readonly Message[], _model: ModelRef): number {
    let totalCharacters = 0;
    let weightedCharacters = 0;
    let toolCallPartCount = 0;

    for (const message of messages) {
      for (const part of message.parts) {
        switch (part.type) {
          case "text":
            [totalCharacters, weightedCharacters] = addText(
              part.text,
              totalCharacters,
              weightedCharacters,
            );
            break;
          case "tool_call":
            [totalCharacters, weightedCharacters] = addText(
              JSON.stringify(part.args),
              totalCharacters,
              weightedCharacters,
            );
            toolCallPartCount += 1;
            break;
          case "tool_result":
            [totalCharacters, weightedCharacters] = addText(
              JSON.stringify(part.result),
              totalCharacters,
              weightedCharacters,
            );
            break;
          case "opaque":
            [totalCharacters, weightedCharacters] = addText(
              JSON.stringify(part),
              totalCharacters,
              weightedCharacters,
            );
            break;
        }
      }
    }

    const estimate =
      Math.ceil(weightedCharacters / 3.5) + 4 * messages.length + 8 * toolCallPartCount;
    return Math.max(Math.ceil(estimate * this.safetyFactor), Math.ceil(totalCharacters / 4));
  }
}

/** Adds per-model EMA calibration to another token counter. */
export class CalibratingTokenCounter implements TokenCounter {
  private readonly ratios = new Map<string, { readonly model: ModelRef; readonly ratio: number }>();

  /**
   * Creates a calibrating wrapper around any token counter.
   *
   * @param inner - Counter whose estimates are calibrated.
   */
  constructor(private readonly inner: TokenCounter) {}

  /** {@inheritDoc TokenCounter.count} */
  count(messages: readonly Message[], model: ModelRef): number {
    const modelRef = ModelRefSchema.parse(model);
    const estimate = this.inner.count(messages, modelRef);
    return Math.ceil(estimate * (this.ratios.get(modelKey(modelRef))?.ratio ?? 1));
  }

  /**
   * Updates this model's calibration from a provider-reported input-token count.
   *
   * @param model - Provider and model that produced the observation.
   * @param estimated - Estimate computed when the request was built.
   * @param actualInputTokens - Input-token count reported by the provider.
   */
  observe(model: ModelRef, estimated: number, actualInputTokens: number): void {
    const modelRef = ModelRefSchema.parse(model);
    if (
      !Number.isFinite(estimated) ||
      estimated <= 0 ||
      !Number.isFinite(actualInputTokens) ||
      actualInputTokens <= 0
    ) {
      return;
    }

    const key = modelKey(modelRef);
    const previousRatio = this.ratios.get(key)?.ratio ?? 1;
    const correctedRatio = clamp(previousRatio * clamp(actualInputTokens / estimated));
    this.ratios.set(key, {
      model: modelRef,
      ratio: clamp(previousRatio * (1 - CALIBRATION_ALPHA) + correctedRatio * CALIBRATION_ALPHA),
    });
  }

  /**
   * Returns deterministic, schema-validated calibration state for a context snapshot.
   *
   * @returns Calibration values sorted by provider and model.
   */
  snapshot(): CalibrationSnapshot {
    return CalibrationSnapshotSchema.parse(
      Array.from(this.ratios.values(), ({ model, ratio }) => ({ model, ratio })).sort(
        (left, right) =>
          `${left.model.provider}\u0000${left.model.model}`.localeCompare(
            `${right.model.provider}\u0000${right.model.model}`,
          ),
      ),
    );
  }

  /**
   * Replaces calibration state from a context snapshot.
   *
   * @param snapshot - Previously captured per-model calibration values.
   */
  restore(snapshot: CalibrationSnapshot): void {
    const entries = CalibrationSnapshotSchema.parse(snapshot);
    this.ratios.clear();
    for (const entry of entries) {
      this.ratios.set(modelKey(entry.model), entry);
    }
  }
}

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}

function clamp(ratio: number): number {
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, ratio));
}

const nonLatinScriptCharacter =
  /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{Z}]/u;

function addText(
  text: string,
  totalCharacters: number,
  weightedCharacters: number,
): [number, number] {
  let nextTotalCharacters = totalCharacters;
  let nextWeightedCharacters = weightedCharacters;
  for (const character of text) {
    nextTotalCharacters += 1;
    nextWeightedCharacters += nonLatinScriptCharacter.test(character) ? 3.5 : 1;
  }
  return [nextTotalCharacters, nextWeightedCharacters];
}
