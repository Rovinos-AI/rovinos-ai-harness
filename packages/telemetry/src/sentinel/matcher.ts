// SPDX-License-Identifier: Apache-2.0
import { AhoCorasick } from "./aho-corasick.js";

/** Transform a raw vault value into the patterns that should be scanned. */
export type SentinelVariantFn = (value: string) => readonly string[];

/**
 * A production matcher that reports only whether text contains a known value.
 */
export class SentinelMatcher {
  private constructor(private readonly automaton: AhoCorasick | undefined) {}

  /**
   * Build a matcher for vault values, optionally expanding each value into patterns.
   * Empty value sets avoid constructing or scanning an automaton.
   * @param values Raw values known to the vault.
   * @param variantFn Optional function returning patterns for each value.
   */
  static forValues(
    values: readonly string[],
    variantFn: SentinelVariantFn = (value) => [value],
  ): SentinelMatcher {
    if (values.length === 0) {
      return new SentinelMatcher(undefined);
    }

    const patterns: string[] = [];
    for (const value of values) {
      patterns.push(...variantFn(value));
    }
    return new SentinelMatcher(AhoCorasick.build(patterns));
  }

  /** Return whether text contains a known value without returning matched content. */
  hasMatch(text: string): boolean {
    return this.automaton?.hasMatch(text) ?? false;
  }
}
