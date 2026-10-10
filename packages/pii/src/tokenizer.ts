// SPDX-License-Identifier: Apache-2.0
import {
  DetectorTextSchema,
  DetectionSchema,
  JsonValue as JsonValueSchema,
  PiiActionSummarySchema,
  PiiEntitySchema,
  type Code,
  type Destination,
  type Detection,
  type Id,
  type JsonValue,
  type PiiAction,
  type PiiActionSummary,
  type PiiBoundary,
  type PiiPolicy,
} from "@harness/schemas";
import { findTokens, isToken, type VaultWriter } from "@harness/vault";
import { PiiBlockedError, PiiTokenizerError } from "./errors.js";
import { assertJsonSize, JsonSizeTracker } from "./json-size.js";
import { evaluatePiiPolicy } from "./policy.js";

const MAX_JSON_DEPTH = 64;
const ACTION_PRIORITY: Readonly<Record<PiiAction, number>> = {
  allow: 0,
  tokenize: 1,
  redact: 2,
  block: 3,
};

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly entityType: string;
  readonly action: PiiAction;
}

interface EvaluatedDetection {
  readonly detection: Detection;
  readonly action: PiiAction;
  readonly entityType: Code;
}

interface TextPlan {
  readonly text: string;
  readonly replacements: readonly Replacement[];
}

interface ActionCounts {
  readonly actions: Map<PiiAction, Map<Code, number>>;
  readonly blocked: Map<Code, number>;
  readonly keys: Map<Code, number>;
}

interface EntityCount {
  readonly type: Code;
  readonly count: number;
}

type JsonContainer = JsonValue[] | Readonly<Record<string, JsonValue>>;

/** Registry interface required by the tokenizer. */
export interface PiiDetectorRegistry {
  /** Detect entities in text using UTF-16 offsets; may reject if a detector fails. */
  detect(text: string): readonly Detection[] | Promise<readonly Detection[]>;
}

/** Tokenizer dependencies. Supply only the vault writer capability. */
export interface TokenizerDependencies {
  readonly detectors: PiiDetectorRegistry;
  readonly policy: PiiPolicy;
  readonly vault: VaultWriter;
}

/** Detects sensitive entities, applies policy, and tokenizes/redacts approved output. */
export class Tokenizer {
  constructor(private readonly dependencies: TokenizerDependencies) {}

  /**
   * Apply policy to detected entities in text.
   *
   * @param runId - Run that owns generated tokens.
   * @param text - Text to inspect.
   * @param context - Trust boundary and destination.
   * @returns Sanitized text and metadata-only action summaries.
   */
  async tokenizeText(
    runId: Id,
    text: string,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
  ): Promise<{ text: string; actions: PiiActionSummary[] }> {
    if (!DetectorTextSchema.safeParse(text).success) {
      throw new PiiTokenizerError("pii_input_invalid");
    }
    const counts = createActionCounts();
    const plan = await this.planText(text, context, counts);
    this.throwIfBlocked(counts);
    return {
      text: await this.applyPlan(runId, plan),
      actions: summarizeActions(context.boundary, counts.actions),
    };
  }

  /**
   * Apply policy to JSON strings; reject disallowed PII in keys rather than rewriting them.
   *
   * @param runId - Run that owns generated tokens.
   * @param value - JSON value to inspect.
   * @param context - Trust boundary and destination.
   * @returns Sanitized JSON and metadata-only action summaries.
   */
  async tokenizeJson(
    runId: Id,
    value: JsonValue,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
  ): Promise<{ value: JsonValue; actions: PiiActionSummary[] }> {
    const validated = this.copyJson(value);
    assertJsonSize(validated);

    const counts = createActionCounts();
    const plans: TextPlan[] = [];
    await this.collectPlans(validated, context, counts, plans);
    if (counts.keys.size > 0) {
      throw new PiiTokenizerError("pii_key_contains_pii", toEntityCounts(counts.keys));
    }
    this.throwIfBlocked(counts);

    const strings: string[] = [];
    for (const plan of plans) {
      strings.push(await this.applyPlan(runId, plan));
    }
    let stringIndex = 0;
    return {
      value: this.rebuildJson(validated, strings, () => stringIndex++),
      actions: summarizeActions(context.boundary, counts.actions),
    };
  }

  private copyJson(
    value: JsonValue,
    depth = 0,
    ancestors = new Set<JsonContainer>(),
    size = new JsonSizeTracker(),
  ): JsonValue {
    if (depth > MAX_JSON_DEPTH) {
      throw new PiiTokenizerError("pii_depth_exceeded");
    }
    if (typeof value !== "object" || value === null) {
      if (!JsonValueSchema.safeParse(value).success) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      size.addValue(value);
      return value;
    }
    if (ancestors.has(value)) {
      throw new PiiTokenizerError("pii_input_invalid");
    }
    let isArray: boolean;
    let copy: JsonContainer;
    try {
      isArray = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (
        (isArray && prototype !== Array.prototype) ||
        (!isArray && prototype !== Object.prototype && prototype !== null)
      ) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      copy = Array.isArray(value) ? [...value] : Object.fromEntries(Object.entries(value));
    } catch {
      throw new PiiTokenizerError("pii_input_invalid");
    }
    size.addContainer(copy);
    ancestors.add(value);
    const result = Array.isArray(copy)
      ? copy.map((child) => this.copyJson(child, depth + 1, ancestors, size))
      : Object.fromEntries(
          Object.entries(copy).map(([key, child]) => [
            key,
            this.copyJson(child, depth + 1, ancestors, size),
          ]),
        );
    ancestors.delete(value);
    return result;
  }

  private async collectPlans(
    value: JsonValue,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
    counts: ActionCounts,
    plans: TextPlan[],
  ): Promise<void> {
    if (typeof value === "string") {
      plans.push(await this.planText(value, context, counts));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        await this.collectPlans(child, context, counts, plans);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        await this.planText(key, context, counts, true);
        await this.collectPlans(child, context, counts, plans);
      }
    }
  }

  private async planText(
    text: string,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
    counts: ActionCounts,
    isKey = false,
  ): Promise<TextPlan> {
    const tokens = findTokens(text).map(({ index, token }) => ({
      start: index,
      end: index + token.length,
    }));
    const maskedText = maskTokenSpans(text, tokens);
    let found: readonly Detection[];
    try {
      found = await this.dependencies.detectors.detect(maskedText);
    } catch {
      throw new PiiTokenizerError("pii_detector_failed");
    }
    const evaluated: EvaluatedDetection[] = [];
    try {
      for (const detection of found) {
        const parsed = DetectionSchema.safeParse(detection);
        if (!parsed.success || parsed.data.end > maskedText.length) {
          throw new PiiTokenizerError("pii_detector_invalid_output");
        }
        if (intersectsToken(parsed.data.start, parsed.data.end, tokens)) {
          continue;
        }
        const entity = PiiEntitySchema.safeParse(parsed.data.entityType);
        if (!entity.success) {
          throw new PiiTokenizerError("pii_detector_invalid_output");
        }
        const action = evaluatePiiPolicy(this.dependencies.policy, {
          entity: entity.data,
          boundary: context.boundary,
          destination: context.destination,
        });
        addCount(counts.actions, action, entity.data);
        if (isKey && action !== "allow") {
          counts.keys.set(entity.data, (counts.keys.get(entity.data) ?? 0) + 1);
        }
        if (action === "block") {
          counts.blocked.set(entity.data, (counts.blocked.get(entity.data) ?? 0) + 1);
        }
        evaluated.push({ detection: parsed.data, action, entityType: entity.data });
      }
    } catch (error) {
      if (error instanceof PiiTokenizerError) {
        throw error;
      }
      throw new PiiTokenizerError("pii_detector_invalid_output");
    }

    const replacements: Replacement[] = [];
    for (const item of resolvePolicyOverlaps(evaluated)) {
      if (item.action !== "allow" && item.action !== "block") {
        replacements.push({
          start: item.detection.start,
          end: item.detection.end,
          raw: text.slice(item.detection.start, item.detection.end),
          entityType: item.entityType,
          action: item.action,
        });
      }
    }
    return { text, replacements };
  }

  private throwIfBlocked(counts: ActionCounts): void {
    if (counts.blocked.size > 0) {
      throw new PiiBlockedError(toEntityCounts(counts.blocked));
    }
  }

  private async applyPlan(runId: Id, plan: TextPlan): Promise<string> {
    const replacements: { readonly start: number; readonly end: number; readonly value: string }[] =
      [];
    for (const replacement of plan.replacements) {
      let value: string;
      if (replacement.action === "redact") {
        value = `[REDACTED:${replacement.entityType}]`;
      } else {
        let token: string;
        try {
          token = await this.dependencies.vault.put(runId, replacement.entityType, replacement.raw);
        } catch {
          throw new PiiTokenizerError("pii_vault_failed");
        }
        if (!isToken(token)) {
          throw new PiiTokenizerError("pii_vault_failed");
        }
        value = token;
      }
      replacements.push({ start: replacement.start, end: replacement.end, value });
    }
    replacements.sort((left, right) => right.start - left.start);
    let result = plan.text;
    for (const replacement of replacements) {
      result =
        result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
    }
    return result;
  }

  private rebuildJson(
    value: JsonValue,
    strings: readonly string[],
    nextIndex: () => number,
  ): JsonValue {
    if (typeof value === "string") {
      const tokenized = strings[nextIndex()];
      if (tokenized === undefined) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      return tokenized;
    }
    if (Array.isArray(value)) {
      return value.map((child) => this.rebuildJson(child, strings, nextIndex));
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(result, key, {
          value: this.rebuildJson(child, strings, nextIndex),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    return value;
  }
}

function createActionCounts(): ActionCounts {
  return { actions: new Map(), blocked: new Map(), keys: new Map() };
}

function addCount(
  counts: Map<PiiAction, Map<Code, number>>,
  action: PiiAction,
  entity: Code,
): void {
  const entities = counts.get(action) ?? new Map<Code, number>();
  entities.set(entity, (entities.get(entity) ?? 0) + 1);
  counts.set(action, entities);
}

function toEntityCounts(counts: ReadonlyMap<Code, number>): EntityCount[] {
  return [...counts.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([type, count]) => ({ type, count }));
}

function summarizeActions(
  boundary: PiiBoundary,
  counts: ReadonlyMap<PiiAction, Map<Code, number>>,
): PiiActionSummary[] {
  return [...counts.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([action, entities]) =>
      PiiActionSummarySchema.parse({
        boundary,
        action,
        entities: toEntityCounts(entities),
      }),
    );
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function maskTokenSpans(
  text: string,
  tokens: readonly { readonly start: number; readonly end: number }[],
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    parts.push(text.slice(cursor, token.start), " ".repeat(token.end - token.start));
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function intersectsToken(
  start: number,
  end: number,
  tokens: readonly { readonly start: number; readonly end: number }[],
): boolean {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const token = tokens[middle];
    if (token !== undefined && token.end <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const token = tokens[low];
  return token !== undefined && token.start < end;
}

function resolvePolicyOverlaps(detections: readonly EvaluatedDetection[]): EvaluatedDetection[] {
  const sorted = [...detections].sort((left, right) => {
    const startDifference = left.detection.start - right.detection.start;
    return startDifference !== 0 ? startDifference : left.detection.end - right.detection.end;
  });
  const resolved: EvaluatedDetection[] = [];
  let group: EvaluatedDetection[] = [];
  let groupStart = 0;
  let groupEnd = 0;
  for (const current of sorted) {
    if (group.length === 0) {
      group = [current];
      groupStart = current.detection.start;
      groupEnd = current.detection.end;
    } else if (current.detection.start < groupEnd) {
      group.push(current);
      groupEnd = Math.max(groupEnd, current.detection.end);
    } else {
      resolved.push(mergePolicyOverlapGroup(group, groupStart, groupEnd));
      group = [current];
      groupStart = current.detection.start;
      groupEnd = current.detection.end;
    }
  }
  if (group.length > 0) {
    resolved.push(mergePolicyOverlapGroup(group, groupStart, groupEnd));
  }
  return resolved;
}

function mergePolicyOverlapGroup(
  group: readonly EvaluatedDetection[],
  start: number,
  end: number,
): EvaluatedDetection {
  const winner = group.reduce((preferred, candidate) =>
    isPreferredPolicyDetection(candidate, preferred) ? candidate : preferred,
  );
  return {
    ...winner,
    detection: { ...winner.detection, start, end },
  };
}

function isPreferredPolicyDetection(
  candidate: EvaluatedDetection,
  preferred: EvaluatedDetection,
): boolean {
  const priorityDifference = ACTION_PRIORITY[candidate.action] - ACTION_PRIORITY[preferred.action];
  if (priorityDifference !== 0) {
    return priorityDifference > 0;
  }
  const candidateLength = candidate.detection.end - candidate.detection.start;
  const preferredLength = preferred.detection.end - preferred.detection.start;
  if (candidateLength !== preferredLength) {
    return candidateLength > preferredLength;
  }
  if (candidate.detection.confidence !== preferred.detection.confidence) {
    return candidate.detection.confidence > preferred.detection.confidence;
  }
  return compareOrdinal(candidate.detection.detectorId, preferred.detection.detectorId) < 0;
}
