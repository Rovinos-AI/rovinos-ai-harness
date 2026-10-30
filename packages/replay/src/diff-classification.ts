// SPDX-License-Identifier: Apache-2.0
import type { DiffSummary } from "./diff.js";

/** Options that affect whether metric fields are classified as noise. */
export interface NoiseClassificationOptions {
  readonly ignoreMetrics?: boolean;
}

/** Root field name shared by nested flattened paths. */
export function rootDiffField(field: string): string {
  return field.split(".", 1)[0] ?? field;
}

/** Converts a field name to the repository's snake-case code form. */
export function diffFieldCodeName(field: string): string {
  return field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** Determines whether a normalized field is expected replay noise. */
export function isNoiseDiffField(field: string, options: NoiseClassificationOptions): boolean {
  const name = rootDiffField(field);
  return (
    name === "latencyMs" ||
    name === "waitMs" ||
    (options.ignoreMetrics === true && (name === "costMicros" || name === "repairAttempts"))
  );
}

/** Determines whether a report should fail for a behavioral or strict noise difference. */
export function hasReplayDifferences(summary: DiffSummary, strict: boolean): boolean {
  return summary.behavioral > 0 || (strict && summary.noise > 0);
}
