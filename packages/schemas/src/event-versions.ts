// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { EventSchema, EventEnvelopeSchema, type Event, type EventType } from "./events.js";
import { ContractError } from "./parse.js";
import { Id, Traceparent } from "./primitives.js";
import { SnapshotSchema, type Snapshot } from "./snapshot.js";

/** Current schema version for each event type. */
export const EVENT_SCHEMA_VERSIONS = {
  run_created: 1,
  run_input: 1,
  run_status_changed: 1,
  model_request: 2,
  model_response: 1,
  tool_intent: 1,
  tool_execution_started: 1,
  tool_result: 1,
  approval_requested: 1,
  approval_resolved: 2,
  input_requested: 1,
  input_resolved: 1,
  app_content: 1,
  checkpoint_written: 1,
  context_compacted: 1,
  pii_action: 1,
  budget_exceeded: 1,
  subagent_spawned: 1,
  subagent_completed: 1,
} satisfies Record<EventType, number>;

/** A pure transformation from one event payload version to the next. */
export type EventUpcaster = (payload: unknown) => unknown;

/** Per-event migrations keyed by the version they read. */
export type EventUpcasterMap = Partial<Record<EventType, Readonly<Record<number, EventUpcaster>>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure migrations from event schema version n to n + 1. */
export const UPCASTERS: EventUpcasterMap = {
  model_request: {
    1: modelRequestV1ToV2,
  },
  approval_resolved: {
    1: approvalResolvedV1ToV2,
  },
};

/** Legacy logs lack the non-message inputs; retain their original full-request hash verification. */
function modelRequestV1ToV2(payload: unknown): unknown {
  return isRecord(payload) ? { ...payload, requestParametersHash: null } : payload;
}

/** Supplies the human decision identity missing from v1 approval resolutions. */
function approvalResolvedV1ToV2(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  return Object.hasOwn(payload, "decidedBy") ? payload : { ...payload, decidedBy: "human" };
}

/** Raw event envelope schema; payload keys are validated by the current strict schema after upcasting. */
export const RawEventEnvelopeSchema = EventEnvelopeSchema.extend({
  type: z.enum([
    "run_created",
    "run_input",
    "run_status_changed",
    "model_request",
    "model_response",
    "tool_intent",
    "tool_execution_started",
    "tool_result",
    "approval_requested",
    "approval_resolved",
    "input_requested",
    "input_resolved",
    "app_content",
    "checkpoint_written",
    "context_compacted",
    "pii_action",
    "budget_exceeded",
    "subagent_spawned",
    "subagent_completed",
  ]),
}).loose();

/** Current version used for newly written snapshots. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Pure migrations from snapshot schema version n to n + 1. */
export const SNAPSHOT_UPCASTERS: Readonly<Record<number, EventUpcaster>> = {};

const snapshotRawSchema = z
  .object({
    snapshotId: Id,
    runId: Id,
    atSeq: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    traceparent: Traceparent,
    v: z.number().int().positive().optional(),
  })
  .loose();
const eventEnvelopeKeys = new Set([
  "runId",
  "seq",
  "ts",
  "type",
  "v",
  "traceId",
  "spanId",
  "segmentId",
]);
const snapshotEnvelopeKeys = new Set([
  "snapshotId",
  "runId",
  "atSeq",
  "createdAt",
  "traceparent",
  "v",
]);

function contractError(error: z.ZodError): ContractError {
  return new ContractError(
    error.issues.map(({ path, code }) => ({
      path: path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
      code,
    })),
  );
}

/** Applies a consecutive sequence of pure version transformations. */
export function applyUpcasterChain(options: {
  readonly payload: unknown;
  readonly initialVersion: number;
  readonly currentVersion: number;
  readonly upcasters?: Readonly<Record<number, EventUpcaster>>;
  readonly path: string;
}): { readonly payload: unknown; readonly version: number } {
  let version = options.initialVersion;
  let currentPayload = options.payload;
  while (version < options.currentVersion) {
    const upcaster = options.upcasters?.[version];
    if (upcaster === undefined) {
      throw new ContractError([{ path: [options.path, "v"], code: "upcaster_missing" }]);
    }
    try {
      currentPayload = upcaster(currentPayload);
    } catch {
      throw new ContractError([{ path: [options.path, "v"], code: "upcaster_failed" }]);
    }
    version += 1;
  }
  return { payload: currentPayload, version };
}

/**
 * Upcasts a stored event to its current schema version and validates the strict current event schema.
 *
 * @param raw - Untrusted event from an append-only log.
 * @returns The validated current-version event.
 * @throws ContractError for malformed envelopes, unsupported versions, missing upcasters, or payloads.
 */
export function upcastEvent(raw: unknown): Event {
  const envelope = RawEventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw contractError(envelope.error);
  }
  const { type, v } = envelope.data;
  const currentVersion = EVENT_SCHEMA_VERSIONS[type];
  if (v > currentVersion) {
    throw new ContractError([{ path: ["v"], code: "event_version_unsupported" }]);
  }
  const payload = Object.fromEntries(
    Object.entries(envelope.data).filter(([key]) => !eventEnvelopeKeys.has(key)),
  );
  const upcasters = UPCASTERS[type];
  const upcast = applyUpcasterChain({
    payload,
    initialVersion: v,
    currentVersion,
    path: type,
    ...(upcasters === undefined ? {} : { upcasters }),
  });
  if (!isRecord(upcast.payload)) {
    throw new ContractError([{ path: [type], code: "event_payload_invalid" }]);
  }
  if (Object.keys(upcast.payload).some((key) => eventEnvelopeKeys.has(key))) {
    throw new ContractError([{ path: [type], code: "event_payload_invalid" }]);
  }
  const value = {
    ...upcast.payload,
    runId: envelope.data.runId,
    seq: envelope.data.seq,
    ts: envelope.data.ts,
    type,
    v: upcast.version,
    traceId: envelope.data.traceId,
    spanId: envelope.data.spanId,
    segmentId: envelope.data.segmentId,
  };
  const result = EventSchema.safeParse(value);
  if (!result.success) {
    throw contractError(result.error);
  }
  return result.data;
}

/**
 * Upcasts a stored snapshot using the shared version-chain mechanism.
 *
 * @param raw - Untrusted snapshot from an append-only log.
 * @returns The validated current-version snapshot.
 * @throws ContractError for missing upcasters, unsupported versions, or invalid snapshots.
 */
export function upcastSnapshot(raw: unknown): Snapshot {
  const parsed = snapshotRawSchema.safeParse(raw);
  if (!parsed.success) {
    throw contractError(parsed.error);
  }
  const version = parsed.data.v ?? 1;
  if (version > SNAPSHOT_SCHEMA_VERSION) {
    throw new ContractError([{ path: ["v"], code: "snapshot_version_unsupported" }]);
  }
  const payload = Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => !snapshotEnvelopeKeys.has(key)),
  );
  const upcast = applyUpcasterChain({
    payload,
    initialVersion: version,
    currentVersion: SNAPSHOT_SCHEMA_VERSION,
    upcasters: SNAPSHOT_UPCASTERS,
    path: "snapshot",
  });
  if (!isRecord(upcast.payload)) {
    throw new ContractError([{ path: ["snapshot"], code: "snapshot_payload_invalid" }]);
  }
  if (Object.keys(upcast.payload).some((key) => snapshotEnvelopeKeys.has(key))) {
    throw new ContractError([{ path: ["snapshot"], code: "snapshot_payload_invalid" }]);
  }
  const value = {
    ...upcast.payload,
    snapshotId: parsed.data.snapshotId,
    runId: parsed.data.runId,
    atSeq: parsed.data.atSeq,
    createdAt: parsed.data.createdAt,
    traceparent: parsed.data.traceparent,
    v: upcast.version,
  };
  const result = SnapshotSchema.safeParse(value);
  if (!result.success) {
    throw contractError(result.error);
  }
  return result.data;
}
