// SPDX-License-Identifier: Apache-2.0
import type { RunView } from "./types.js";

/** Project run usage into the public view without exposing internal counters. */
export function projectRunViewUsage(usage: RunView["usage"]): RunView["usage"] {
  const { inputTokens, outputTokens, cost } = usage;
  return { inputTokens, outputTokens, cost };
}
