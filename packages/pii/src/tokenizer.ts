// SPDX-License-Identifier: Apache-2.0
import {
  DetectorTextSchema,
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
import { isToken, type VaultWriter } from "@harness/vault";
import { PiiBlockedError, PiiTokenizerError } from "./errors.js";
import { assertJsonSize, JsonSizeTracker } from "./json-size.js";
import { evaluatePiiPolicy } from "./policy.js";
import {
  detectOutsideTokenSpans,
  resolvePolicyOverlaps,
  type EvaluatedDetection,
} from "./tokenizer-helpers.js";

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
    const copy = snapshotJsonContainer(value, size);
    if (!Array.isArray(copy)) {
      size.addContainer(copy);
    }
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
    const detections = await detectOutsideTokenSpans(text, (maskedText) =>
      this.dependencies.detectors.detect(maskedText),
    );
    const evaluated = detections.map((detection) =>
      this.evaluateDetection(detection, context, counts, isKey),
    );

    const replacements: Replacement[] = [];
    for (const item of resolvePolicyOverlaps(evaluated)) {
      addCount(counts.actions, item.action, item.entityType);
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

  private evaluateDetection(
    detection: Detection,
    context: { readonly boundary: PiiBoundary; readonly destination: Destination },
    counts: ActionCounts,
    isKey: boolean,
  ): EvaluatedDetection {
    const entity = PiiEntitySchema.safeParse(detection.entityType);
    if (!entity.success) {
      throw new PiiTokenizerError("pii_detector_invalid_output");
    }
    const action = evaluatePiiPolicy(this.dependencies.policy, {
      entity: entity.data,
      boundary: context.boundary,
      destination: context.destination,
    });
    if (isKey && action !== "allow") {
      counts.keys.set(entity.data, (counts.keys.get(entity.data) ?? 0) + 1);
    }
    if (action === "block") {
      counts.blocked.set(entity.data, (counts.blocked.get(entity.data) ?? 0) + 1);
    }
    return { detection, action, entityType: entity.data };
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

function snapshotJsonContainer(value: JsonContainer, size: JsonSizeTracker): JsonContainer {
  try {
    if (isJsonArray(value)) {
      if (Reflect.getPrototypeOf(value) !== Array.prototype) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      const length = Reflect.get(value, "length");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw new PiiTokenizerError("pii_input_invalid");
      }
      size.addArrayContainer(length);
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new PiiTokenizerError("pii_input_invalid");
        }
        const child = value[index];
        if (child === undefined) {
          throw new PiiTokenizerError("pii_input_invalid");
        }
        copy.push(child);
      }
      return copy;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PiiTokenizerError("pii_input_invalid");
    }
    return Object.fromEntries(Object.entries(value));
  } catch (error) {
    if (error instanceof PiiTokenizerError) {
      throw error;
    }
    throw new PiiTokenizerError("pii_input_invalid");
  }
}

function isJsonArray(value: JsonContainer): value is JsonValue[] {
  return Array.isArray(value);
}
