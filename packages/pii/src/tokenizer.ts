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
import { resolveOverlaps } from "./detectors/overlaps.js";
import { PiiBlockedError, PiiTokenizerError } from "./errors.js";
import { assertJsonSize } from "./json-size.js";
import { evaluatePiiPolicy } from "./policy.js";

const MAX_JSON_DEPTH = 64;

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly entityType: string;
  readonly action: PiiAction;
}

interface TextPlan {
  readonly text: string;
  readonly replacements: readonly Replacement[];
}

interface ActionCounts {
  readonly actions: Map<PiiAction, Map<Code, number>>;
  readonly blocked: Map<Code, number>;
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
   * Apply policy recursively to JSON string values, leaving object keys unchanged.
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
    this.assertJsonDepth(value);
    if (!JsonValueSchema.safeParse(value).success) {
      throw new PiiTokenizerError("pii_input_invalid");
    }
    assertJsonSize(value);

    const counts = createActionCounts();
    const plans: TextPlan[] = [];
    await this.collectPlans(value, context, counts, plans);
    this.throwIfBlocked(counts);

    const strings: string[] = [];
    for (const plan of plans) {
      strings.push(await this.applyPlan(runId, plan));
    }
    let stringIndex = 0;
    return {
      value: this.rebuildJson(value, strings, () => stringIndex++),
      actions: summarizeActions(context.boundary, counts.actions),
    };
  }

  private assertJsonDepth(value: JsonValue): void {
    const ancestors = new Set<JsonContainer>();
    const stack: {
      readonly value: JsonValue;
      readonly depth: number;
      readonly leave?: JsonContainer;
    }[] = [{ value, depth: 0 }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined) {
        continue;
      }
      if (item.leave !== undefined) {
        ancestors.delete(item.leave);
        continue;
      }
      if (item.depth > MAX_JSON_DEPTH) {
        throw new PiiTokenizerError("pii_depth_exceeded");
      }
      if (typeof item.value !== "object" || item.value === null) {
        continue;
      }
      if (ancestors.has(item.value)) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      ancestors.add(item.value);
      stack.push({ value: null, depth: item.depth, leave: item.value });
      const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
      for (const child of [...children].reverse()) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
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
      for (const child of Object.values(value)) {
        await this.collectPlans(child, context, counts, plans);
      }
    }
  }

  private async planText(
    text: string,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
    counts: ActionCounts,
  ): Promise<TextPlan> {
    const tokens = findTokens(text).map(({ index, token }) => ({
      start: index,
      end: index + token.length,
    }));
    const detections: Detection[] = [];
    let cursor = 0;
    for (const token of tokens) {
      await this.detectSegment(text.slice(cursor, token.start), cursor, detections);
      cursor = token.end;
    }
    await this.detectSegment(text.slice(cursor), cursor, detections);

    let resolved: Detection[];
    try {
      resolved = resolveOverlaps(detections);
    } catch {
      throw new PiiTokenizerError("pii_detector_invalid_output");
    }
    const replacements: Replacement[] = [];
    for (const detection of resolved) {
      if (
        detection.end > text.length ||
        tokens.some((token) => detection.start < token.end && detection.end > token.start)
      ) {
        throw new PiiTokenizerError("pii_detector_invalid_output");
      }
      const entity = PiiEntitySchema.safeParse(detection.entityType);
      if (!entity.success) {
        throw new PiiTokenizerError("pii_detector_invalid_output");
      }
      const action = evaluatePiiPolicy(this.dependencies.policy, {
        entity: entity.data,
        boundary: context.boundary,
        destination: context.destination,
      });
      addCount(counts.actions, action, entity.data);
      if (action === "block") {
        counts.blocked.set(entity.data, (counts.blocked.get(entity.data) ?? 0) + 1);
      } else if (action !== "allow") {
        replacements.push({
          start: detection.start,
          end: detection.end,
          raw: text.slice(detection.start, detection.end),
          entityType: entity.data,
          action,
        });
      }
    }
    return { text, replacements };
  }

  private async detectSegment(
    segment: string,
    offset: number,
    detections: Detection[],
  ): Promise<void> {
    if (segment.length === 0) {
      return;
    }
    let found: readonly Detection[];
    try {
      found = await this.dependencies.detectors.detect(segment);
    } catch {
      throw new PiiTokenizerError("pii_detector_failed");
    }
    try {
      for (const detection of found) {
        const parsed = DetectionSchema.safeParse(detection);
        if (!parsed.success || parsed.data.end > segment.length) {
          throw new PiiTokenizerError("pii_detector_invalid_output");
        }
        detections.push({
          ...parsed.data,
          start: parsed.data.start + offset,
          end: parsed.data.end + offset,
        });
      }
    } catch (error) {
      if (error instanceof PiiTokenizerError) {
        throw error;
      }
      throw new PiiTokenizerError("pii_detector_invalid_output");
    }
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
  return { actions: new Map(), blocked: new Map() };
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

function summarizeActions(
  boundary: PiiBoundary,
  counts: ReadonlyMap<PiiAction, Map<Code, number>>,
): PiiActionSummary[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action, entities]) =>
      PiiActionSummarySchema.parse({
        boundary,
        action,
        entities: toEntityCounts(entities),
      }),
    );
}
