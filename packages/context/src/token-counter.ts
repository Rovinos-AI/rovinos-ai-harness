// SPDX-License-Identifier: Apache-2.0
import { ModelRefSchema, type JsonValue, type Message, type ModelRef } from "@harness/schemas";
import { z } from "zod";

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

/** Counts normalized messages for a model. */
export interface TokenCounter {
  /**
   * Estimates the input-token count for the supplied messages.
   *
   * @param messages - Normalized messages sent to the model.
   * @param model - Provider and model used for the request.
   * @returns The estimated input-token count.
   */
  count(messages: readonly Message[], model: ModelRef): number;
}

/** Conservative character-based token estimate, replaceable by an exact tokenizer. */
export class HeuristicTokenCounter implements TokenCounter {
  private readonly safetyFactor: number;

  /**
   * Creates a heuristic counter with a configurable conservative margin.
   *
   * @param safetyFactor - Positive multiplier applied to the estimate; defaults to 1.15.
   */
  constructor(safetyFactor = DEFAULT_SAFETY_FACTOR) {
    this.safetyFactor = z.number().finite().positive().parse(safetyFactor);
  }

  /** {@inheritDoc TokenCounter.count} */
  count(messages: readonly Message[], _model: ModelRef): number {
    let totalCharacters = 0;
    let toolCallPartCount = 0;

    for (const message of messages) {
      for (const part of message.parts) {
        switch (part.type) {
          case "text":
            totalCharacters += part.text.length;
            break;
          case "tool_call":
            totalCharacters += serializedLength(part.args);
            toolCallPartCount += 1;
            break;
          case "tool_result":
            totalCharacters += serializedLength(part.result);
            break;
          case "opaque":
            totalCharacters += serializedLength(part);
            break;
        }
      }
    }

    const estimate = Math.ceil(totalCharacters / 3.5) + 4 * messages.length + 8 * toolCallPartCount;
    return Math.max(Math.ceil(estimate * this.safetyFactor), Math.ceil(totalCharacters / 4));
  }
}

/** Adds per-model EMA calibration to another token counter. */
export class CalibratingTokenCounter implements TokenCounter {
  private readonly ratios = new Map<string, number>();

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
    return Math.ceil(estimate * (this.ratios.get(modelKey(modelRef)) ?? 1));
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
      actualInputTokens < 0
    ) {
      return;
    }

    const key = modelKey(modelRef);
    const observedRatio = clamp(actualInputTokens / estimated);
    const previousRatio = this.ratios.get(key) ?? 1;
    this.ratios.set(
      key,
      clamp(previousRatio * (1 - CALIBRATION_ALPHA) + observedRatio * CALIBRATION_ALPHA),
    );
  }

  /**
   * Returns deterministic, schema-validated calibration state for a context snapshot.
   *
   * @returns Calibration values sorted by provider and model.
   */
  snapshot(): CalibrationSnapshot {
    return CalibrationSnapshotSchema.parse(
      Array.from(this.ratios, ([key, ratio]) => {
        const [provider, model] = key.split("/");
        return { model: { provider, model }, ratio };
      }).sort((left, right) =>
        `${left.model.provider}/${left.model.model}`.localeCompare(
          `${right.model.provider}/${right.model.model}`,
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
      this.ratios.set(modelKey(entry.model), entry.ratio);
    }
  }
}

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}

function clamp(ratio: number): number {
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, ratio));
}

function serializedLength(value: JsonValue): number {
  return JSON.stringify(value)?.length ?? 0;
}
