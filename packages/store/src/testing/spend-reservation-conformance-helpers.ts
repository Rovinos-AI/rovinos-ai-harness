// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  type Id,
  type NewEvent,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import type { SpendReservationStore } from "../spend-reservation.js";
import type { UsageAppendOptions } from "../types.js";
import { createEventBuilders } from "./testing.js";

/** Shared deterministic event builders for spend-reservation conformance tests. */
export const builders = createEventBuilders();
/** UTC day used by spend-reservation conformance tests. */
export const basePeriodStart = Date.UTC(2026, 10, 12);
/** Shared quota identifier for spend-reservation conformance tests. */
export const baseQuotaId = Code.parse("quota.daily");

/** Create a synthetic quota period for a conformance test. */
export function quota(
  quotaId: Code = baseQuotaId,
  limitMicros = 1_000,
  periodStartValue = basePeriodStart,
): SpendReservationInput["quotaPeriods"][number] {
  return { quotaId, period: "day", periodStart: periodStartValue, limitMicros };
}

/** Create a valid reservation request with optional overrides. */
export function input(
  runId: Id,
  attemptId: Id,
  options: {
    quotaPeriods?: SpendReservationInput["quotaPeriods"];
    estimatedMicros?: number;
    pricingRevision?: Code;
  } = {},
): SpendReservationInput {
  return {
    runId,
    attemptId,
    quotaPeriods: options.quotaPeriods ?? [quota()],
    ...(options.estimatedMicros === undefined ? {} : { estimatedMicros: options.estimatedMicros }),
    ...(options.pricingRevision === undefined ? {} : { pricingRevision: options.pricingRevision }),
  };
}

/** Create a model-request event bound to the attempt id. */
export function modelRequest(
  runId: Id,
  attemptId: Id,
): Extract<NewEvent, { type: "model_request" }> {
  return { ...builders.modelRequest(runId), requestId: attemptId };
}

/** Create a synthetic model-response event for settlement conformance. */
export function modelResponse(
  runId: Id,
  attemptId: Id,
  cost: Extract<SpendReservationSettlement["cost"], { state: "known" | "estimated" | "partial" }>,
): Extract<NewEvent, { type: "model_response" }> {
  return {
    runId,
    ts: 2,
    v: 2,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
    type: "model_response",
    requestId: attemptId,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    cost,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic response" }],
    providerBlobs: null,
  };
}

/** Create a complete synthetic settlement for a model-call attempt. */
export function settlement(
  runId: Id,
  attemptId: Id,
  amountMicros: number,
  responseHash = "b".repeat(64),
): SpendReservationSettlement {
  return {
    runId,
    attemptId,
    cost: { version: 1, state: "known", amountMicros },
    responseHash,
  };
}

/** Create the audited operator-waiver event used by conformance tests. */
export function resolutionEvent(
  runId: Id,
  attemptId: Id,
): Extract<NewEvent, { type: "spend_reservation_resolved" }> {
  const envelope = modelRequest(runId, attemptId);
  return {
    runId,
    ts: 3,
    v: 1,
    traceId: envelope.traceId,
    spanId: envelope.spanId,
    segmentId: envelope.segmentId,
    type: "spend_reservation_resolved",
    attemptId,
    decision: "waive",
    decidedBy: "cli.operator",
    reason: "operator_reviewed",
  };
}

/** Create usage-ledger changes matching the supplied reservation quota periods. */
export function usageUpdates(
  quotaPeriods: SpendReservationInput["quotaPeriods"],
  amountMicros: number,
): UsageAppendOptions {
  return {
    usageUpdates: quotaPeriods.map(({ quotaId, period, periodStart }) => ({
      quotaId,
      period,
      periodStart,
      costMicros: amountMicros,
      runsStarted: 0,
    })),
  };
}

/** Append the initial run event and return the next expected sequence. */
export async function seedRun(store: SpendReservationStore, runId: Id): Promise<number> {
  const { nextSeq } = await store.append(runId, [builders.runCreated(runId)], 0);
  return nextSeq;
}

/** Create a backend, execute one conformance case, and always clean it up. */
export async function withStore<T>(
  factory: () => Promise<{ store: SpendReservationStore; cleanup: () => Promise<void> }>,
  run: (store: SpendReservationStore) => Promise<T>,
): Promise<T> {
  const { store, cleanup } = await factory();
  try {
    return await run(store);
  } finally {
    await cleanup();
  }
}
