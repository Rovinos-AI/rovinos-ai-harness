// SPDX-License-Identifier: Apache-2.0
import { Code, type Event, type Code as EventCode } from "@rovinos/schemas";
import { toSafeEvent } from "@rovinos/telemetry";

interface NormalizedObject {
  readonly [key: string]: NormalizedValue;
}

type NormalizedValue = string | number | boolean | readonly NormalizedValue[] | NormalizedObject;

/** A content-free event projection with run-specific envelope values removed. */
export type NormalizedEvent = Readonly<Record<string, NormalizedValue>>;

/** A scalar metadata difference between two normalized events. */
export interface DiffField {
  readonly field: EventCode;
  readonly a: string | number | boolean;
  readonly b: string | number | boolean;
}

/** A metadata-only event addition, removal, or change. */
export interface DiffEntry {
  readonly kind: "added" | "removed" | "changed";
  /** Zero-based source index for removals and changes; target index for additions. */
  readonly index: number;
  readonly eventKind: EventCode;
  readonly fields?: DiffField[];
  readonly class: "behavioral" | "noise";
}

/** Counts of event changes, split by operation and behavior class. */
export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly behavioral: number;
  readonly noise: number;
}

/** Options controlling metadata comparison. */
export interface DiffOptions {
  /** Fields to omit from comparison, identified by their Code names. */
  readonly ignoreFields?: readonly EventCode[];
  /** Compare token-valued metadata when true. Defaults to true. */
  readonly compareTokens?: boolean;
  /** Classify cost and repair metrics as noise instead of behavior. */
  readonly ignoreMetrics?: boolean;
}

/** Result of structurally comparing two event logs. */
export interface DiffResult {
  /** True when the logs have no behavioral differences; noise-only differences are identical. */
  readonly identical: boolean;
  readonly summary: DiffSummary;
  readonly entries: DiffEntry[];
  /** True when the event-count cap required positional rather than LCS alignment. */
  readonly approximate: boolean;
}

const MAX_LCS_EVENTS = 5_000;
const DROPPED_FIELDS = new Set("runId seq ts traceId spanId segmentId policyVersion".split(" "));
const ID_ALIASES: Readonly<Record<string, string>> = {
  callId: "call",
  parentCallId: "call",
  approvalId: "approval",
  requestId: "request",
  checkpointId: "checkpoint",
  childRunId: "childRun",
  replayOf: "run",
};
const TOKEN_VALUE = /^<[A-Z][A-Z0-9]*_\d+>$/u;
const ABSENT = "absent";

interface DiffContext {
  readonly options: DiffOptions;
  readonly ignoredFields: ReadonlySet<string>;
}

class IdAliases {
  private readonly aliases = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  alias(kind: string, id: string): string {
    const key = `${kind}:${id}`;
    const existing = this.aliases.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const next = (this.counts.get(kind) ?? 0) + 1;
    const alias = `${kind}#${String(next)}`;
    this.aliases.set(key, alias);
    this.counts.set(kind, next);
    return alias;
  }
}

function normalizeValue(value: unknown, aliases: IdAliases, field?: string): NormalizedValue {
  if (typeof value === "string") {
    const aliasKind = field === undefined ? undefined : ID_ALIASES[field];
    return aliasKind === undefined ? value : aliases.alias(aliasKind, value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, aliases));
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, NormalizedValue> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!DROPPED_FIELDS.has(key)) {
        normalized[key] = normalizeValue(nestedValue, aliases, key);
      }
    }
    return normalized;
  }
  throw new TypeError("Safe event contained an unsupported value.");
}

function isNormalizedObject(value: NormalizedValue): value is NormalizedObject {
  return typeof value === "object" && !Array.isArray(value);
}

function isNormalizedArray(value: NormalizedValue): value is readonly NormalizedValue[] {
  return Array.isArray(value);
}

/**
 * Project events through the telemetry-safe allowlist, remove volatile envelope fields,
 * and replace identifiers with aliases assigned by first appearance.
 *
 * @param events - Validated events from one run.
 * @returns Content-free normalized events in their original order.
 */
export function normalizeRun(events: readonly Event[]): NormalizedEvent[] {
  const aliases = new IdAliases();
  return events.map((event) => {
    const safeEvent = toSafeEvent(event);
    if (safeEvent === null) {
      return { kind: event.type };
    }
    const normalized = normalizeValue(safeEvent, aliases);
    if (!isNormalizedObject(normalized)) {
      throw new TypeError("Safe event projection was not an object.");
    }
    return normalized;
  });
}

type Scalar = string | number | boolean;
type FlattenedEvent = Map<string, Scalar>;

function rootField(field: string): string {
  return field.split(".", 1)[0] ?? field;
}

function codeFieldName(field: string): string {
  return field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function isIgnoredField(field: string, context: DiffContext): boolean {
  return (
    context.ignoredFields.has(codeFieldName(field)) ||
    context.ignoredFields.has(codeFieldName(rootField(field)))
  );
}

function isNoiseField(field: string, options: DiffOptions): boolean {
  const name = rootField(field);
  return (
    name === "latencyMs" ||
    name === "waitMs" ||
    (options.ignoreMetrics === true && (name === "costMicros" || name === "repairAttempts"))
  );
}

function flattenEvent(event: NormalizedEvent, context: DiffContext): FlattenedEvent {
  const values: FlattenedEvent = new Map();
  const include = (field: string, value: Scalar): void => {
    if (
      isIgnoredField(field, context) ||
      (context.options.compareTokens === false &&
        typeof value === "string" &&
        TOKEN_VALUE.test(value))
    ) {
      return;
    }
    values.set(field, value);
  };
  const visit = (value: NormalizedValue, field: string): void => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      include(field, value);
      return;
    }
    if (isNormalizedArray(value)) {
      if (value.length === 0) {
        include(field, "empty");
        return;
      }
      for (const [index, entry] of value.entries()) {
        visit(entry, `${field}.${String(index)}`);
      }
      return;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      include(field, "empty");
      return;
    }
    for (const [key, nestedValue] of entries) {
      visit(nestedValue, `${field}.${key}`);
    }
  };
  for (const [field, value] of Object.entries(event)) {
    visit(value, field);
  }
  return values;
}

function sortedEntries(values: FlattenedEvent): [string, Scalar][] {
  return [...values.entries()].sort(([fieldA], [fieldB]) => {
    if (fieldA < fieldB) {
      return -1;
    }
    if (fieldA > fieldB) {
      return 1;
    }
    return 0;
  });
}

function signature(values: FlattenedEvent, options: DiffOptions): string {
  return JSON.stringify(sortedEntries(values).filter(([field]) => !isNoiseField(field, options)));
}

function signatures(events: readonly NormalizedEvent[], context: DiffContext): string[] {
  return events.map((event) => signature(flattenEvent(event, context), context.options));
}

function lcsMatches(a: readonly string[], b: readonly string[]): [number, number][] {
  const columns = b.length + 1;
  const lengths = new Uint16Array((a.length + 1) * columns);
  for (let aIndex = a.length - 1; aIndex >= 0; aIndex -= 1) {
    for (let bIndex = b.length - 1; bIndex >= 0; bIndex -= 1) {
      const current = aIndex * columns + bIndex;
      lengths[current] =
        a[aIndex] === b[bIndex]
          ? (lengths[(aIndex + 1) * columns + bIndex + 1] ?? 0) + 1
          : Math.max(lengths[(aIndex + 1) * columns + bIndex] ?? 0, lengths[current + 1] ?? 0);
    }
  }

  const matches: [number, number][] = [];
  let aIndex = 0;
  let bIndex = 0;
  while (aIndex < a.length && bIndex < b.length) {
    if (a[aIndex] === b[bIndex]) {
      matches.push([aIndex, bIndex]);
      aIndex += 1;
      bIndex += 1;
      continue;
    }
    const skipA = lengths[(aIndex + 1) * columns + bIndex] ?? 0;
    const skipB = lengths[aIndex * columns + bIndex + 1] ?? 0;
    if (skipA >= skipB) {
      aIndex += 1;
    } else {
      bIndex += 1;
    }
  }
  return matches;
}

function fieldCode(field: string): EventCode {
  return Code.parse(codeFieldName(field).slice(0, 64));
}

function changedFields(
  a: NormalizedEvent,
  b: NormalizedEvent,
  context: DiffContext,
): { behavioral: DiffField[]; noise: DiffField[] } {
  const valuesA = flattenEvent(a, context);
  const valuesB = flattenEvent(b, context);
  const fields = new Set([...valuesA.keys(), ...valuesB.keys()]);
  const behavioral: DiffField[] = [];
  const noise: DiffField[] = [];
  for (const field of [...fields].sort()) {
    const valueA = valuesA.get(field);
    const valueB = valuesB.get(field);
    if (valueA === valueB) {
      continue;
    }
    const diffField: DiffField = {
      field: fieldCode(field),
      a: valueA ?? ABSENT,
      b: valueB ?? ABSENT,
    };
    (isNoiseField(field, context.options) ? noise : behavioral).push(diffField);
  }
  return { behavioral, noise };
}

function eventKind(event: NormalizedEvent): EventCode {
  const kind = event.kind;
  if (typeof kind !== "string") {
    throw new TypeError("Normalized event has no kind.");
  }
  return Code.parse(kind);
}

function changedEntries(
  a: NormalizedEvent,
  b: NormalizedEvent,
  index: number,
  context: DiffContext,
): DiffEntry[] {
  const fields = changedFields(a, b, context);
  const kind = eventKind(a);
  const entries: DiffEntry[] = [];
  if (fields.behavioral.length > 0) {
    entries.push({
      kind: "changed",
      index,
      eventKind: kind,
      fields: fields.behavioral,
      class: "behavioral",
    });
  }
  if (fields.noise.length > 0) {
    entries.push({
      kind: "changed",
      index,
      eventKind: kind,
      fields: fields.noise,
      class: "noise",
    });
  }
  return entries;
}

function addedEntry(event: NormalizedEvent, index: number): DiffEntry {
  return { kind: "added", index, eventKind: eventKind(event), class: "behavioral" };
}

function removedEntry(event: NormalizedEvent, index: number): DiffEntry {
  return { kind: "removed", index, eventKind: eventKind(event), class: "behavioral" };
}

function positionalDiff(
  a: readonly NormalizedEvent[],
  b: readonly NormalizedEvent[],
  context: DiffContext,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const sharedLength = Math.min(a.length, b.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const eventA = a[index];
    const eventB = b[index];
    if (eventA !== undefined && eventB !== undefined) {
      entries.push(...changedEntries(eventA, eventB, index, context));
    }
  }
  for (let index = sharedLength; index < a.length; index += 1) {
    const event = a[index];
    if (event !== undefined) {
      entries.push(removedEntry(event, index));
    }
  }
  for (let index = sharedLength; index < b.length; index += 1) {
    const event = b[index];
    if (event !== undefined) {
      entries.push(addedEntry(event, index));
    }
  }
  return entries;
}

function alignedDiff(
  a: readonly NormalizedEvent[],
  b: readonly NormalizedEvent[],
  context: DiffContext,
): DiffEntry[] {
  const signaturesA = signatures(a, context);
  const signaturesB = signatures(b, context);
  const matches = lcsMatches(signaturesA, signaturesB);
  const entries: DiffEntry[] = [];
  let previousA = 0;
  let previousB = 0;
  const anchors: [number, number][] = [...matches, [a.length, b.length]];

  for (const [anchorA, anchorB] of anchors) {
    const sharedLength = Math.min(anchorA - previousA, anchorB - previousB);
    for (let offset = 0; offset < sharedLength; offset += 1) {
      const eventA = a[previousA + offset];
      const eventB = b[previousB + offset];
      if (eventA !== undefined && eventB !== undefined) {
        entries.push(...changedEntries(eventA, eventB, previousA + offset, context));
      }
    }
    for (let index = previousA + sharedLength; index < anchorA; index += 1) {
      const event = a[index];
      if (event !== undefined) {
        entries.push(removedEntry(event, index));
      }
    }
    for (let index = previousB + sharedLength; index < anchorB; index += 1) {
      const event = b[index];
      if (event !== undefined) {
        entries.push(addedEntry(event, index));
      }
    }

    if (anchorA < a.length && anchorB < b.length) {
      const eventA = a[anchorA];
      const eventB = b[anchorB];
      if (eventA !== undefined && eventB !== undefined) {
        entries.push(...changedEntries(eventA, eventB, anchorA, context));
      }
      previousA = anchorA + 1;
      previousB = anchorB + 1;
    }
  }
  return entries;
}

/**
 * Compare two event logs using safe event projections and noise-aware LCS alignment.
 *
 * @param eventsA - The original event log.
 * @param eventsB - The replay event log.
 * @param options - Optional field and token comparison controls.
 * @returns Metadata-only differences and aggregate counts.
 */
export function diffRuns(
  eventsA: readonly Event[],
  eventsB: readonly Event[],
  options: DiffOptions = {},
): DiffResult {
  const a = normalizeRun(eventsA);
  const b = normalizeRun(eventsB);
  const context: DiffContext = {
    options,
    ignoredFields: new Set((options.ignoreFields ?? []).map(String)),
  };
  const approximate = a.length > MAX_LCS_EVENTS || b.length > MAX_LCS_EVENTS;
  const entries = approximate ? positionalDiff(a, b, context) : alignedDiff(a, b, context);
  const summary: DiffSummary = {
    added: entries.filter(({ kind }) => kind === "added").length,
    removed: entries.filter(({ kind }) => kind === "removed").length,
    changed: entries.filter(({ kind }) => kind === "changed").length,
    behavioral: entries.filter(({ class: changeClass }) => changeClass === "behavioral").length,
    noise: entries.filter(({ class: changeClass }) => changeClass === "noise").length,
  };
  return {
    identical: summary.behavioral === 0,
    summary,
    entries,
    approximate,
  };
}
