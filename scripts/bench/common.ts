// SPDX-License-Identifier: Apache-2.0
import { Bench } from "tinybench";
import { Code, Id, type Event, type NewEvent, type VaultValueEntry } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { BenchmarkResult } from "./contracts.js";

/** Reproducible smoke or nightly benchmark sampling configuration. */
export interface BenchmarkProfile {
  readonly name: "smoke" | "nightly";
  readonly durationMs: number;
  readonly warmupMs: number;
}

/** Measured percentile, throughput, and sample count for one scenario. */
export interface Measurement {
  readonly p95Ms: number;
  readonly operationsPerSecond: number;
  readonly sampleCount: number;
}

export const MAX_LOG_EVENTS = 100_000;
export const hash = "a".repeat(64);
export const traceId = "b".repeat(32);
export const spanId = "c".repeat(16);
const ID_LIMIT = 26;

/** Creates a deterministic benchmark identifier. */
export function makeId(value: number): Id {
  return Id.parse(String(value).padStart(ID_LIMIT, "0"));
}

/** Creates the first event for a synthetic benchmark run. */
export function runCreated(runId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_created",
    configHash: hash,
    policyVersion: "bench",
    depth: 0,
  };
}

/** Creates a synthetic benchmark input event. */
export function runInput(runId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_input",
    input: { value: "synthetic benchmark input" },
    inputKind: "follow_up",
  };
}

/** Creates a run status event with the specified transition. */
export function statusChange(
  runId: Id,
  ts: number,
  transition: {
    readonly from: "pending" | "running";
    readonly to: "running" | "completed" | "suspended";
    readonly reason: "started" | "completed" | "awaiting_approval";
  },
): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "run_status_changed",
    ...transition,
  };
}

/** Creates a synthetic approval request event. */
export function approvalRequested(runId: Id, approvalId: Id, ts: number): NewEvent {
  return {
    runId,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: runId,
    type: "approval_requested",
    approvalId,
    callId: makeId(900_000 + Number(approvalId.slice(-6))),
    payload: {},
  };
}

/** Runs a Tinybench scenario and computes its p95 from retained samples. */
export async function measure<T>(
  name: string,
  callback: () => T | Promise<T>,
  profile: BenchmarkProfile,
): Promise<Measurement> {
  const bench = new Bench({
    name,
    time: profile.durationMs,
    warmupTime: profile.warmupMs,
    retainSamples: true,
  });
  bench.add(name, callback);
  await bench.run();
  const task = bench.getTask(name);
  if (task === undefined || !("latency" in task.result) || !("throughput" in task.result)) {
    throw new Error("benchmark_failed");
  }
  const samples = task.result.latency.samples;
  if (samples === undefined || samples.length === 0) {
    throw new Error("benchmark_samples_missing");
  }
  const sortedSamples = [...samples].sort((left, right) => left - right);
  const p95Index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * 0.95) - 1);
  const p95Sample = sortedSamples[p95Index];
  if (p95Sample === undefined || !Number.isFinite(p95Sample)) {
    throw new Error("benchmark_samples_invalid");
  }
  return {
    p95Ms: p95Sample,
    operationsPerSecond: task.result.throughput.mean,
    sampleCount: task.runs,
  };
}

/** Creates a nonnegative benchmark measurement. */
export function metric(
  name: string,
  value: number,
  unit: "ops/s" | "events/s" | "ms" | "MiB/s",
  sampleCount: number,
): BenchmarkResult["metrics"][number] {
  return { name, value: Math.max(0, value), unit, sampleCount: Math.max(1, sampleCount) };
}

/** Reads all events for a synthetic run into memory. */
export async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

/** Appends a synthetic batch to the event store. */
export async function appendInputBatch(
  store: EventStore,
  runId: Id,
  from: number,
  count: number,
): Promise<void> {
  const events = Array.from({ length: count }, (_, index) => runInput(runId, from + index));
  await store.append(runId, events, from - 1);
}

/** Creates distinct synthetic values for vault-backed sentinel scenarios. */
export function syntheticVaultValues(count: number): VaultValueEntry[] {
  const entityType = Code.parse("email");
  return Array.from({ length: count }, (_, index) => ({
    entityType,
    rawValue: `a${index.toString(36).padStart(4, "0")}z`,
  }));
}
