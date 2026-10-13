// SPDX-License-Identifier: Apache-2.0
import { type Code, HarnessError, type Id, type JsonValue, type PiiConfig } from "@harness/schemas";
import { findTokens } from "@harness/vault";
import type { AuditingVaultResolver, VaultAuditHandler } from "@harness/vault";

/** Result of detokenizing an allowlisted tool argument copy. */
export interface DetokenizeArgsResult {
  readonly args: JsonValue;
  readonly resolvedCount: number;
}

/** Raised when an allowlisted token cannot be resolved. */
export class PiiTokenUnresolvableError extends HarnessError {
  /** Stable error code for unknown or purged tokens. */
  readonly code = "pii_token_unresolvable";

  /** Create a safe error without retaining or exposing the token. */
  constructor() {
    super("An allowlisted PII token could not be resolved");
  }
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: cloneJsonValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  }
  return value;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

class DetokenizationVisitor {
  private resolvedCount = 0;

  constructor(
    private readonly runId: Id,
    private readonly toolId: Code,
    private readonly onUnresolvable: "fail" | "leave",
    private readonly resolver: AuditingVaultResolver,
    private readonly onAudit?: VaultAuditHandler,
  ) {}

  get count(): number {
    return this.resolvedCount;
  }

  async apply(value: JsonValue, segments: readonly string[], depth: number): Promise<JsonValue> {
    if (depth === segments.length) {
      return typeof value === "string" ? this.replaceTokens(value) : value;
    }

    const segment = decodePointerSegment(segments[depth] ?? "");
    if (Array.isArray(value)) {
      return this.applyArray(value, segments, depth, segment);
    }

    if (segment === "*") {
      return value;
    }
    if (value !== null && typeof value === "object") {
      return this.applyObject(value, segments, depth, segment);
    }
    return value;
  }

  private async applyArray(
    value: JsonValue[],
    segments: readonly string[],
    depth: number,
    segment: string,
  ): Promise<JsonValue[]> {
    if (segment === "*") {
      const copy = value.slice();
      for (const [index, child] of copy.entries()) {
        copy[index] = await this.apply(child, segments, depth + 1);
      }
      return copy;
    }

    if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
      return value;
    }
    const index = Number(segment);
    if (!Number.isSafeInteger(index) || index >= value.length) {
      return value;
    }
    const child = value[index];
    if (child === undefined) {
      return value;
    }
    const copy = value.slice();
    copy[index] = await this.apply(child, segments, depth + 1);
    return copy;
  }

  private async applyObject(
    value: Record<string, JsonValue>,
    segments: readonly string[],
    depth: number,
    segment: string,
  ): Promise<Record<string, JsonValue>> {
    if (!Object.hasOwn(value, segment)) {
      return value;
    }
    const child = value[segment];
    if (child === undefined) {
      return value;
    }

    const copy = { ...value };
    Object.defineProperty(copy, segment, {
      value: await this.apply(child, segments, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return copy;
  }

  private async replaceTokens(text: string): Promise<string> {
    const matches = findTokens(text);
    if (matches.length === 0) {
      return text;
    }

    const values = await this.resolver.resolveMany(
      this.runId,
      matches.map(({ token }) => token),
      { boundary: "tool_input", toolId: this.toolId },
      this.onAudit,
    );
    let result = "";
    let offset = 0;

    for (const [index, match] of matches.entries()) {
      result += text.slice(offset, match.index);
      const resolvedValue = values[index];
      if (resolvedValue === undefined) {
        if (this.onUnresolvable === "fail") {
          throw new PiiTokenUnresolvableError();
        }
        result += match.token;
      } else {
        result += resolvedValue;
        this.resolvedCount += 1;
      }
      offset = match.index + match.token.length;
    }

    return result + text.slice(offset);
  }
}

/**
 * Resolve tokens only at the configured JSON Pointers for a tool, returning an in-memory copy.
 *
 * @param runId - Run that owns the tokens.
 * @param toolId - Tool receiving the detokenized arguments.
 * @param args - Tokenized JSON arguments.
 * @param config - Validated PII configuration with tool argument allowlists.
 * @param resolver - Auditing resolver; all token resolutions use the `tool_input` boundary.
 * @returns A deep copy with allowlisted tokens resolved and the number of resolved occurrences.
 */
// eslint-disable-next-line max-params -- preserve the specified task 13.5 public API
export async function detokenizeArgs(
  runId: Id,
  toolId: Code,
  args: JsonValue,
  config: PiiConfig,
  resolver: AuditingVaultResolver,
  onAudit?: VaultAuditHandler,
): Promise<DetokenizeArgsResult> {
  let copy = cloneJsonValue(args);
  const entry = config.detokenize?.find((candidate) => candidate.toolId === toolId);
  if (entry === undefined) {
    return { args: copy, resolvedCount: 0 };
  }

  const visitor = new DetokenizationVisitor(runId, toolId, entry.onUnresolvable, resolver, onAudit);
  for (const pointer of entry.args) {
    const segments = pointer === "" ? [] : pointer.slice(1).split("/");
    copy = await visitor.apply(copy, segments, 0);
  }

  return { args: copy, resolvedCount: visitor.count };
}
