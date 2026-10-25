// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";

export const MAX_TOTAL_PATTERN_CHARS = 1_000_000;

interface TrieNode {
  readonly transitions: Map<number, number>;
  failure: number;
  outputLink: number;
  readonly outputs: { patternIndex: number; patternLength: number }[];
}

/** Closed error codes for sentinel matcher failures. */
export class AhoCorasickError extends HarnessError {
  readonly code:
    | "sentinel_pattern_empty"
    | "sentinel_patterns_too_large"
    | "sentinel_matcher_invalid"
    | "sentinel_scan_timeout";

  constructor(code: AhoCorasickError["code"]) {
    super(code);
    this.code = code;
  }
}

function createNode(): TrieNode {
  return { transitions: new Map(), failure: 0, outputLink: 0, outputs: [] };
}

function nodeAt(nodes: readonly TrieNode[], index: number): TrieNode {
  const node = nodes[index];
  if (node === undefined) {
    throw new AhoCorasickError("sentinel_matcher_invalid");
  }
  return node;
}

/**
 * A case-sensitive multi-pattern matcher using UTF-16 code-unit offsets.
 */
export class AhoCorasick {
  private constructor(
    private readonly nodes: readonly TrieNode[],
    private readonly patternCount: number,
  ) {}

  /**
   * Build a trie and its failure and dictionary links.
   * @param patterns Patterns to find; empty patterns are rejected.
   */
  static build(patterns: readonly string[]): AhoCorasick {
    let totalPatternChars = 0;
    for (const pattern of patterns) {
      if (pattern.length === 0) {
        throw new AhoCorasickError("sentinel_pattern_empty");
      }
      totalPatternChars += pattern.length;
      if (totalPatternChars > MAX_TOTAL_PATTERN_CHARS) {
        throw new AhoCorasickError("sentinel_patterns_too_large");
      }
    }

    const nodes: TrieNode[] = [createNode()];
    for (const [patternIndex, pattern] of patterns.entries()) {
      let nodeIndex = 0;
      for (let offset = 0; offset < pattern.length; offset += 1) {
        const codeUnit = pattern.charCodeAt(offset);
        const node = nodeAt(nodes, nodeIndex);

        let nextNodeIndex = node.transitions.get(codeUnit);
        if (nextNodeIndex === undefined) {
          nextNodeIndex = nodes.length;
          node.transitions.set(codeUnit, nextNodeIndex);
          nodes.push(createNode());
        }
        nodeIndex = nextNodeIndex;
      }

      nodeAt(nodes, nodeIndex).outputs.push({
        patternIndex,
        patternLength: pattern.length,
      });
    }

    const queue: number[] = [];
    const root = nodeAt(nodes, 0);
    for (const childIndex of root.transitions.values()) {
      queue.push(childIndex);
    }

    for (const nodeIndex of queue) {
      const node = nodeAt(nodes, nodeIndex);
      for (const [codeUnit, childIndex] of node.transitions) {
        let failureIndex = node.failure;
        while (
          failureIndex !== 0 &&
          nodeAt(nodes, failureIndex).transitions.get(codeUnit) === undefined
        ) {
          failureIndex = nodeAt(nodes, failureIndex).failure;
        }

        const failureNode = nodeAt(nodes, failureIndex);
        const fallbackIndex = failureNode.transitions.get(codeUnit);
        const child = nodeAt(nodes, childIndex);
        child.failure = fallbackIndex ?? 0;

        const outputNode = nodeAt(nodes, child.failure);
        child.outputLink = outputNode.outputs.length > 0 ? child.failure : outputNode.outputLink;
        queue.push(childIndex);
      }
    }

    return new AhoCorasick(nodes, patterns.length);
  }

  /** Return immediately when any pattern is found without exposing matched text. */
  hasMatch(text: string): boolean {
    let state = 0;
    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      let node = nodeAt(this.nodes, state);

      while (state !== 0 && node.transitions.get(codeUnit) === undefined) {
        state = node.failure;
        node = nodeAt(this.nodes, state);
      }
      state = node.transitions.get(codeUnit) ?? 0;
      node = nodeAt(this.nodes, state);
      if (node.outputs.length > 0 || node.outputLink !== 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return each matching pattern index at most once without allocating occurrence ranges.
   * @param text Text to scan.
   * @param shouldStop Optional deadline check, called during scanning and output traversal.
   */
  findPatternIndexes(text: string, shouldStop: () => boolean = () => false): number[] {
    if (this.patternCount === 0) {
      return [];
    }
    const matches: number[] = [];
    const seen = new Uint8Array(this.patternCount);
    const skippedOutputs = new Map<number, number>();
    let matchedCount = 0;
    let state = 0;

    const firstUnseenOutput = (nodeIndex: number): number => {
      let current = nodeIndex;
      const path: number[] = [];
      while (current !== 0) {
        const next = skippedOutputs.get(current);
        if (next === undefined) {
          break;
        }
        path.push(current);
        current = next;
      }
      for (const skipped of path) {
        skippedOutputs.set(skipped, current);
      }
      return current;
    };

    for (let index = 0; index < text.length; index += 1) {
      if (shouldStop()) {
        throw new AhoCorasickError("sentinel_scan_timeout");
      }
      const codeUnit = text.charCodeAt(index);
      let node = nodeAt(this.nodes, state);
      while (state !== 0 && node.transitions.get(codeUnit) === undefined) {
        state = node.failure;
        node = nodeAt(this.nodes, state);
      }
      state = node.transitions.get(codeUnit) ?? 0;
      node = nodeAt(this.nodes, state);

      let outputIndex = firstUnseenOutput(node.outputs.length > 0 ? state : node.outputLink);
      while (outputIndex !== 0) {
        if (shouldStop()) {
          throw new AhoCorasickError("sentinel_scan_timeout");
        }
        const outputNode = nodeAt(this.nodes, outputIndex);
        for (const { patternIndex } of outputNode.outputs) {
          if (seen[patternIndex] === 0) {
            seen[patternIndex] = 1;
            matches.push(patternIndex);
            matchedCount += 1;
          }
        }
        skippedOutputs.set(outputIndex, outputNode.outputLink);
        outputIndex = firstUnseenOutput(outputNode.outputLink);
      }
      if (matchedCount === this.patternCount) {
        break;
      }
    }
    return matches;
  }

  /**
   * Return matching pattern indexes and UTF-16 ranges for tests and diagnostics only.
   * Matched text is intentionally never returned.
   * @internal
   * @param text Text to scan.
   */
  findAll(text: string): { patternIndex: number; start: number; end: number }[] {
    const matches: { patternIndex: number; start: number; end: number }[] = [];
    let state = 0;

    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      let node = nodeAt(this.nodes, state);

      while (state !== 0 && node.transitions.get(codeUnit) === undefined) {
        state = node.failure;
        node = nodeAt(this.nodes, state);
      }
      state = node.transitions.get(codeUnit) ?? 0;
      node = nodeAt(this.nodes, state);

      let outputNode: TrieNode | undefined = node;
      while (outputNode !== undefined) {
        for (const { patternIndex, patternLength } of outputNode.outputs) {
          matches.push({
            patternIndex,
            start: index - patternLength + 1,
            end: index + 1,
          });
        }
        outputNode =
          outputNode.outputLink === 0 ? undefined : nodeAt(this.nodes, outputNode.outputLink);
      }
    }
    return matches;
  }
}
