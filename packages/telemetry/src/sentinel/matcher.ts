// SPDX-License-Identifier: Apache-2.0
import { AhoCorasick } from "./aho-corasick.js";

/** Transform a raw vault value into the patterns that should be scanned. */
export type SentinelVariantFn = (value: string) => readonly string[];

/**
 * A production matcher that reports only whether text contains a known value.
 */
export class SentinelMatcher {
  private constructor(
    private readonly automaton: AhoCorasick | undefined,
    private readonly valueIndexesByPattern: readonly (readonly number[])[],
  ) {}

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
      return new SentinelMatcher(undefined, []);
    }

    const patterns: string[] = [];
    const patternIndexes = new Map<string, number>();
    const valueIndexesByPattern: number[][] = [];
    for (const [valueIndex, value] of values.entries()) {
      for (const pattern of variantFn(value)) {
        if (pattern.length === 0) {
          continue;
        }
        const existingPatternIndex = patternIndexes.get(pattern);
        if (existingPatternIndex === undefined) {
          patternIndexes.set(pattern, patterns.length);
          patterns.push(pattern);
          valueIndexesByPattern.push([valueIndex]);
        } else if (!valueIndexesByPattern[existingPatternIndex]?.includes(valueIndex)) {
          valueIndexesByPattern[existingPatternIndex]?.push(valueIndex);
        }
      }
    }
    if (patterns.length === 0) {
      return new SentinelMatcher(undefined, []);
    }
    return new SentinelMatcher(AhoCorasick.build(patterns), valueIndexesByPattern);
  }

  /** Return whether text contains a known value without returning matched content. */
  hasMatch(text: string): boolean {
    return this.automaton?.hasMatch(text) ?? false;
  }

  /** Return matched vault-value indexes without returning the matched text. */
  findAll(text: string): readonly { patternIndex: number }[] {
    return (
      this.automaton
        ?.findAll(text)
        .flatMap(({ patternIndex }) =>
          (this.valueIndexesByPattern[patternIndex] ?? []).map((index) => ({
            patternIndex: index,
          })),
        ) ?? []
    );
  }
}
