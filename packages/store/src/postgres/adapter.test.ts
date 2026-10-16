// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { Code, Id, parseJson, type KeyProvider } from "@harness/schemas";
import { AesGcmContentCodec } from "../aes-gcm-codec.js";
import type { ContentCodec } from "../codec.js";
import { InvalidEventError, StoreUnavailableError } from "../errors.js";
import { PostgresEventStore } from "./adapter.js";
import { createEventBuilders, runEventStoreConformance } from "../testing/index.js";
import { z } from "zod";

interface FakeRun {
  run_id: string;
  created_at: number;
  status: string;
  next_seq: number;
  last_ts: number;
}

interface FakeEvent {
  global_seq: number;
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  trace_id: string;
  span_id: string;
  segment_id: string;
  meta: Record<string, unknown>;
  content_blob: string;
  key_id: string | null;
}

interface FakeSnapshot {
  snapshot_id: string;
  run_id: string;
  at_seq: number;
  created_at: number;
  meta_json: Record<string, unknown>;
  content_blob: string;
  key_id: string | null;
}

interface FakeApprovalNotification {
  readonly run_id: string;
  readonly claimed_at: number;
  readonly sent_at?: number;
}

interface FakeIdempotencyClaim {
  readonly run_id: string;
  readonly created_at: number;
}

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

interface FakeNotification {
  processId: number;
  channel: string;
  payload?: string;
}

type FakeNotificationListener = (notification: FakeNotification) => void;

function isNotificationListener(listener: unknown): listener is FakeNotificationListener {
  return typeof listener === "function";
}

function isEndListener(listener: unknown): listener is () => void {
  return typeof listener === "function";
}

let transactionBackup:
  | {
      runs: Map<string, FakeRun>;
      events: FakeEvent[];
      sinkCursors: Map<string, number>;
      snapshots: FakeSnapshot[];
      approvalNotifications: Map<string, FakeApprovalNotification>;
      confirmationStates: Map<string, number>;
      idempotencyKeys: Map<string, FakeIdempotencyClaim>;
    }
  | undefined;

const fakePg = vi.hoisted(() => ({
  runs: new Map<string, FakeRun>(),
  events: new Array<FakeEvent>(),
  sinkCursors: new Map<string, number>(),
  snapshots: new Array<FakeSnapshot>(),
  approvalNotifications: new Map<string, FakeApprovalNotification>(),
  confirmationStates: new Map<string, number>(),
  idempotencyKeys: new Map<string, FakeIdempotencyClaim>(),
  schemaInitialized: false,
  migrationHistory: new Map<string, string>(),
  encryptionValue: "",
  handler: (_sql: string, _values: unknown[]): FakeQueryResult => ({ rows: [] }),
  notificationListeners: new Set<FakeNotificationListener>(),
  listenerEndListeners: new Set<() => void>(),
  listenerListenCount: 0,
  terminalChecks: 0,
  connectError: new Error("connection refused"),
  connectErrorCode: "ECONNREFUSED",
  shouldFailConnect: false,
}));

vi.mock("pg", () => ({
  Client: class {
    on(event: "notification", listener: FakeNotificationListener): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: unknown): this {
      if (event === "notification" && isNotificationListener(listener)) {
        fakePg.notificationListeners.add(listener);
      } else if (event === "end" && isEndListener(listener)) {
        fakePg.listenerEndListeners.add(listener);
      }
      return this;
    }

    removeListener(event: "notification", listener: FakeNotificationListener): this;
    removeListener(event: "end", listener: () => void): this;
    removeListener(event: "error", listener: (error: Error) => void): this;
    removeListener(event: string, listener: unknown): this {
      if (event === "notification" && isNotificationListener(listener)) {
        fakePg.notificationListeners.delete(listener);
      } else if (event === "end" && isEndListener(listener)) {
        fakePg.listenerEndListeners.delete(listener);
      }
      return this;
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    query(sql: string, values: unknown[] = []): Promise<FakeQueryResult> {
      return Promise.resolve().then(() => fakePg.handler(sql, values));
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  },
  Pool: class {
    on(): this {
      return this;
    }

    query(sql: string, values: unknown[] = []): Promise<FakeQueryResult> {
      return Promise.resolve(fakePg.handler(sql, values));
    }

    connect(): Promise<{
      query: (sql: string, values?: unknown[]) => Promise<FakeQueryResult>;
      on: (event: "notification", listener: FakeNotificationListener) => void;
      removeListener: (event: "notification", listener: FakeNotificationListener) => void;
      release: () => void;
    }> {
      if (fakePg.shouldFailConnect) {
        return Promise.reject(
          Object.assign(fakePg.connectError, { code: fakePg.connectErrorCode }),
        );
      }
      return Promise.resolve({
        query: (sql, values) => this.query(sql, values),
        on: (_event, listener) => {
          fakePg.notificationListeners.add(listener);
        },
        removeListener: (_event, listener) => {
          fakePg.notificationListeners.delete(listener);
        },
        release: () => undefined,
      });
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected string SQL value");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError("Expected numeric SQL value");
  }
  return value;
}

function fakeQuery(sql: string, values: unknown[]): FakeQueryResult {
  const query = sql.replaceAll(/\s+/g, " ").trim();
  if (query.startsWith("-- SPDX-License-Identifier: Apache-2.0")) {
    fakePg.schemaInitialized = true;
    return { rows: [] };
  }
  if (query === "DELETE FROM idempotency_keys WHERE run_id = $1") {
    const runId = text(values[0]);
    for (const [keyHash, claim] of fakePg.idempotencyKeys) {
      if (claim.run_id === runId) {
        fakePg.idempotencyKeys.delete(keyHash);
      }
    }
    return { rows: [] };
  }
  if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) {
    fakePg.schemaInitialized = true;
    return { rows: [] };
  }
  if (query.startsWith("SELECT to_regclass('schema_migrations')")) {
    return { rows: [{ present: fakePg.migrationHistory.size > 0 || fakePg.schemaInitialized }] };
  }
  if (query === "LISTEN harness_events" || query === "UNLISTEN harness_events") {
    if (query === "LISTEN harness_events") {
      fakePg.listenerListenCount += 1;
    }
    return { rows: [] };
  }
  if (query === "SELECT next_seq, status FROM runs WHERE run_id = $1") {
    fakePg.terminalChecks += 1;
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ next_seq: run.next_seq, status: run.status }] };
  }
  if (query === "SELECT COALESCE(MAX(global_seq), 0) AS global_seq FROM events") {
    return { rows: [{ global_seq: fakePg.events.at(-1)?.global_seq ?? 0 }] };
  }
  if (
    query ===
    "SELECT run_id, MAX(global_seq) AS global_seq FROM events WHERE global_seq > $1 GROUP BY run_id"
  ) {
    const lastGlobalSeq = number(values[0]);
    const changedRuns = new Map<string, number>();
    for (const event of fakePg.events) {
      if (event.global_seq > lastGlobalSeq) {
        changedRuns.set(
          event.run_id,
          Math.max(changedRuns.get(event.run_id) ?? 0, event.global_seq),
        );
      }
    }
    return {
      rows: [...changedRuns].map(([run_id, global_seq]) => ({ run_id, global_seq })),
    };
  }
  if (query === "SELECT pg_notify($1, $2)") {
    const channel = text(values[0]);
    const payload = text(values[1]);
    for (const listener of fakePg.notificationListeners) {
      listener({ processId: 1, channel, payload });
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT version, checksum FROM schema_migrations")) {
    return {
      rows: [...fakePg.migrationHistory].map(([version, checksum]) => ({ version, checksum })),
    };
  }
  if (query.startsWith("INSERT INTO schema_migrations")) {
    fakePg.migrationHistory.set(text(values[0]), text(values[1]));
    return { rows: [] };
  }
  if (query === "BEGIN" || query === "BEGIN READ ONLY") {
    transactionBackup = {
      runs: structuredClone(fakePg.runs),
      events: structuredClone(fakePg.events),
      sinkCursors: structuredClone(fakePg.sinkCursors),
      snapshots: structuredClone(fakePg.snapshots),
      approvalNotifications: structuredClone(fakePg.approvalNotifications),
      confirmationStates: structuredClone(fakePg.confirmationStates),
      idempotencyKeys: structuredClone(fakePg.idempotencyKeys),
    };
    return { rows: [] };
  }
  if (query.startsWith("SELECT pg_advisory_xact_lock")) {
    return { rows: [] };
  }
  if (query === "BEGIN ISOLATION LEVEL READ COMMITTED") {
    transactionBackup = {
      runs: structuredClone(fakePg.runs),
      events: structuredClone(fakePg.events),
      sinkCursors: structuredClone(fakePg.sinkCursors),
      snapshots: structuredClone(fakePg.snapshots),
      approvalNotifications: structuredClone(fakePg.approvalNotifications),
      confirmationStates: structuredClone(fakePg.confirmationStates),
      idempotencyKeys: structuredClone(fakePg.idempotencyKeys),
    };
    return { rows: [] };
  }
  if (query === "COMMIT") {
    transactionBackup = undefined;
    return { rows: [] };
  }
  if (query === "ROLLBACK") {
    if (transactionBackup !== undefined) {
      fakePg.runs.clear();
      for (const [runId, run] of transactionBackup.runs) {
        fakePg.runs.set(runId, run);
      }
      fakePg.events.splice(0, fakePg.events.length, ...transactionBackup.events);
      fakePg.sinkCursors.clear();
      for (const [sinkId, cursor] of transactionBackup.sinkCursors) {
        fakePg.sinkCursors.set(sinkId, cursor);
      }
      fakePg.snapshots.splice(0, fakePg.snapshots.length, ...transactionBackup.snapshots);
      fakePg.approvalNotifications.clear();
      for (const [approvalId, runId] of transactionBackup.approvalNotifications) {
        fakePg.approvalNotifications.set(approvalId, runId);
      }
      fakePg.confirmationStates.clear();
      for (const [stateId, expiresAt] of transactionBackup.confirmationStates) {
        fakePg.confirmationStates.set(stateId, expiresAt);
      }
      fakePg.idempotencyKeys.clear();
      for (const [keyHash, claim] of transactionBackup.idempotencyKeys) {
        fakePg.idempotencyKeys.set(keyHash, claim);
      }
      transactionBackup = undefined;
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT to_regclass")) {
    return { rows: [{ initialized: fakePg.schemaInitialized }] };
  }
  if (query.startsWith("SELECT metadata_value FROM store_metadata")) {
    return {
      rows: fakePg.encryptionValue === "" ? [] : [{ metadata_value: fakePg.encryptionValue }],
    };
  }
  if (query.startsWith("SELECT (SELECT COUNT(*) FROM events)")) {
    return { rows: [{ count: String(fakePg.events.length + fakePg.snapshots.length) }] };
  }
  if (query.startsWith("INSERT INTO store_metadata")) {
    fakePg.encryptionValue = text(values[1]);
    return { rows: [] };
  }
  if (query.startsWith("SELECT global_seq, run_id, seq, content_blob, key_id FROM events")) {
    const targetKeyId = text(values[0]);
    const after = values[1] === null ? undefined : number(values[1]);
    const limit = number(values[2]);
    return {
      rows: fakePg.events
        .filter(
          (event) =>
            event.key_id !== null &&
            event.key_id !== targetKeyId &&
            (after === undefined || event.global_seq > after),
        )
        .sort((first, second) => first.global_seq - second.global_seq)
        .slice(0, limit),
    };
  }
  if (query.startsWith("SELECT snapshot_id, run_id, at_seq, content_blob, key_id FROM snapshots")) {
    const targetKeyId = text(values[0]);
    const after = typeof values[1] === "string" ? text(values[1]) : "";
    const limit = number(values.at(-1));
    return {
      rows: fakePg.snapshots
        .filter(
          (snapshot) =>
            snapshot.key_id !== null &&
            snapshot.key_id !== targetKeyId &&
            snapshot.snapshot_id > after,
        )
        .sort((first, second) => first.snapshot_id.localeCompare(second.snapshot_id))
        .slice(0, limit),
    };
  }
  if (query.startsWith("UPDATE events SET content_blob")) {
    const event = fakePg.events.find(
      (row) =>
        row.global_seq === number(values[2]) &&
        row.key_id === text(values[3]) &&
        row.content_blob === text(values[4]),
    );
    if (event !== undefined) {
      event.content_blob = text(values[0]);
      event.key_id = text(values[1]);
    }
    return { rows: [], rowCount: event === undefined ? 0 : 1 };
  }
  if (query.startsWith("UPDATE snapshots SET content_blob")) {
    const snapshot = fakePg.snapshots.find(
      (row) =>
        row.snapshot_id === text(values[2]) &&
        row.key_id === text(values[3]) &&
        row.content_blob === text(values[4]),
    );
    if (snapshot !== undefined) {
      snapshot.content_blob = text(values[0]);
      snapshot.key_id = text(values[1]);
    }
    return { rows: [], rowCount: snapshot === undefined ? 0 : 1 };
  }
  if (query.startsWith("SELECT key_id, COUNT(*)::int AS count FROM (")) {
    const counts = new Map<string, number>();
    for (const row of [...fakePg.events, ...fakePg.snapshots]) {
      if (row.key_id !== null) {
        counts.set(row.key_id, (counts.get(row.key_id) ?? 0) + 1);
      }
    }
    return {
      rows: [...counts].map(([key_id, count]) => ({ key_id, count })),
    };
  }
  if (query.startsWith("INSERT INTO runs")) {
    const runId = text(values[0]);
    const createdAt = number(values[1]);
    if (!fakePg.runs.has(runId)) {
      fakePg.runs.set(runId, {
        run_id: runId,
        created_at: createdAt,
        status: "pending",
        next_seq: 0,
        last_ts: createdAt,
      });
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT next_seq, status FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ next_seq: run.next_seq, status: run.status }] };
  }
  if (query.startsWith("SELECT status, next_seq FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return {
      rows: run === undefined ? [] : [{ status: run.status, next_seq: run.next_seq }],
    };
  }
  if (query.startsWith("SELECT status FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ status: run.status }] };
  }
  if (query.startsWith("WITH inserted_events AS") || query.startsWith("INSERT INTO events")) {
    const updatesRun = query.startsWith("WITH inserted_events AS");
    const eventValues = values.length - (updatesRun ? 3 : 0);
    for (let offset = 0; offset < eventValues; offset += 10) {
      const runId = text(values[offset]);
      const seq = number(values[offset + 1]);
      if (fakePg.events.some((event) => event.run_id === runId && event.seq === seq)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const meta = parseJson(z.record(z.string(), z.json()), text(values[offset + 7]));
      fakePg.events.push({
        global_seq: fakePg.events.length + 1,
        run_id: runId,
        seq,
        ts: number(values[offset + 2]),
        type: text(values[offset + 3]),
        trace_id: text(values[offset + 4]),
        span_id: text(values[offset + 5]),
        segment_id: text(values[offset + 6]),
        meta,
        content_blob: text(values[offset + 8]),
        key_id: values[offset + 9] === null ? null : text(values[offset + 9]),
      });
    }
    const run = fakePg.runs.get(text(values[0]));
    if (updatesRun && run !== undefined) {
      run.next_seq = number(values.at(-3));
      run.status = text(values.at(-2));
      run.last_ts = number(values.at(-1));
    }
    return { rows: [] };
  }
  if (query.startsWith("INSERT INTO snapshots")) {
    const snapshotId = text(values[0]);
    if (fakePg.snapshots.some((snapshot) => snapshot.snapshot_id === snapshotId)) {
      throw Object.assign(new Error("duplicate"), {
        code: "23505",
        table: "snapshots",
      });
    }
    fakePg.snapshots.push({
      snapshot_id: snapshotId,
      run_id: text(values[1]),
      at_seq: number(values[2]),
      created_at: number(values[3]),
      meta_json: parseJson(z.record(z.string(), z.json()), text(values[4])),
      content_blob: text(values[5]),
      key_id: values[6] === null ? null : text(values[6]),
    });
    return { rows: [] };
  }
  if (query === "DELETE FROM events WHERE run_id = $1") {
    const runId = text(values[0]);
    const previousLength = fakePg.events.length;
    fakePg.events.splice(
      0,
      previousLength,
      ...fakePg.events.filter((event) => event.run_id !== runId),
    );
    return { rows: [], rowCount: previousLength - fakePg.events.length };
  }
  if (query === "DELETE FROM snapshots WHERE run_id = $1") {
    const runId = text(values[0]);
    fakePg.snapshots.splice(
      0,
      fakePg.snapshots.length,
      ...fakePg.snapshots.filter((snapshot) => snapshot.run_id !== runId),
    );
    return { rows: [] };
  }
  if (query === "DELETE FROM approval_notifications WHERE run_id = $1") {
    const runId = text(values[0]);
    for (const [approvalId, notification] of fakePg.approvalNotifications) {
      if (notification.run_id === runId) {
        fakePg.approvalNotifications.delete(approvalId);
      }
    }
    return { rows: [] };
  }
  if (query === "DELETE FROM control_plane_consumed_states WHERE expires_at <= $1") {
    const now = number(values[0]);
    for (const [stateId, expiresAt] of fakePg.confirmationStates) {
      if (expiresAt <= now) {
        fakePg.confirmationStates.delete(stateId);
      }
    }
    return { rows: [] };
  }
  if (query.startsWith("INSERT INTO control_plane_consumed_states")) {
    const stateId = text(values[0]);
    if (fakePg.confirmationStates.has(stateId)) {
      return { rows: [] };
    }
    fakePg.confirmationStates.set(stateId, number(values[1]));
    return { rows: [{ state_id: stateId }] };
  }
  if (query.startsWith("INSERT INTO idempotency_keys")) {
    const keyHash = text(values[0]);
    const claim = fakePg.idempotencyKeys.get(keyHash) ?? {
      run_id: text(values[1]),
      created_at: number(values[2]),
    };
    fakePg.idempotencyKeys.set(keyHash, claim);
    return { rows: [{ run_id: claim.run_id }] };
  }
  if (query.startsWith("UPDATE idempotency_keys")) {
    const keyHash = text(values[0]);
    const claim = fakePg.idempotencyKeys.get(keyHash);
    if (
      claim?.run_id === text(values[1]) &&
      claim.created_at <= number(values[4]) &&
      !fakePg.events.some((event) => event.run_id === claim.run_id)
    ) {
      fakePg.idempotencyKeys.set(keyHash, {
        run_id: text(values[2]),
        created_at: number(values[3]),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (query === "DELETE FROM idempotency_keys WHERE key_hash = $1 AND run_id = $2") {
    const keyHash = text(values[0]);
    if (fakePg.idempotencyKeys.get(keyHash)?.run_id === text(values[1])) {
      fakePg.idempotencyKeys.delete(keyHash);
    }
    return { rows: [] };
  }
  if (
    query ===
    "DELETE FROM approval_notifications WHERE approval_id = $1 AND run_id = $2 AND claimed_at = $3 AND sent_at IS NULL"
  ) {
    const approvalId = text(values[0]);
    const runId = text(values[1]);
    const claimedAt = number(values[2]);
    const notification = fakePg.approvalNotifications.get(approvalId);
    if (
      notification?.run_id === runId &&
      notification.claimed_at === claimedAt &&
      notification.sent_at === undefined
    ) {
      fakePg.approvalNotifications.delete(approvalId);
    }
    return { rows: [] };
  }
  if (
    query ===
    "UPDATE approval_notifications SET sent_at = $1 WHERE approval_id = $2 AND run_id = $3 AND claimed_at = $4 AND sent_at IS NULL"
  ) {
    const sentAt = number(values[0]);
    const approvalId = text(values[1]);
    const runId = text(values[2]);
    const claimedAt = number(values[3]);
    const notification = fakePg.approvalNotifications.get(approvalId);
    if (
      notification?.run_id === runId &&
      notification.claimed_at === claimedAt &&
      notification.sent_at === undefined
    ) {
      fakePg.approvalNotifications.set(approvalId, { ...notification, sent_at: sentAt });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (query.startsWith("INSERT INTO approval_notifications")) {
    const approvalId = text(values[0]);
    const runId = text(values[1]);
    const claimedAt = number(values[2]);
    const leaseMs = number(values[3]);
    const notification = fakePg.approvalNotifications.get(approvalId);
    if (notification === undefined) {
      fakePg.approvalNotifications.set(approvalId, { run_id: runId, claimed_at: claimedAt });
      return { rows: [{ approval_id: approvalId }] };
    }
    if (
      notification.run_id !== runId ||
      notification.sent_at !== undefined ||
      notification.claimed_at > claimedAt - leaseMs
    ) {
      return { rows: [] };
    }
    fakePg.approvalNotifications.set(approvalId, { run_id: runId, claimed_at: claimedAt });
    return { rows: [{ approval_id: approvalId }] };
  }
  if (query.startsWith("DELETE FROM snapshots")) {
    const runId = text(values[0]);
    const keep = number(values[1]);
    const ordered = fakePg.snapshots
      .filter((snapshot) => snapshot.run_id === runId)
      .sort((first, second) => {
        const atSeqOrder = second.at_seq - first.at_seq;
        return atSeqOrder === 0 ? second.snapshot_id.localeCompare(first.snapshot_id) : atSeqOrder;
      });
    const retainedIds = new Set(ordered.slice(0, keep).map(({ snapshot_id }) => snapshot_id));
    fakePg.snapshots.splice(
      0,
      fakePg.snapshots.length,
      ...fakePg.snapshots.filter(
        (snapshot) => snapshot.run_id !== runId || retainedIds.has(snapshot.snapshot_id),
      ),
    );
    return { rows: [] };
  }
  if (query === "DELETE FROM runs WHERE run_id = $1") {
    fakePg.runs.delete(text(values[0]));
    return { rows: [] };
  }
  if (query.startsWith("SELECT snapshot_id, run_id, at_seq")) {
    const runId = text(values[0]);
    const rows = fakePg.snapshots
      .filter((snapshot) => snapshot.run_id === runId)
      .sort((first, second) => {
        const atSeqOrder = second.at_seq - first.at_seq;
        return atSeqOrder === 0 ? second.snapshot_id.localeCompare(first.snapshot_id) : atSeqOrder;
      });
    const limit = query.includes("LIMIT $2") ? number(values[1]) : 1;
    return { rows: rows.slice(0, limit) };
  }
  if (query.startsWith("SELECT run_id, seq, ts, type")) {
    const runId = text(values[0]);
    const fromSeq = number(values[1]);
    const toSeq = values[2] === null ? undefined : number(values[2]);
    const limit = number(values[3]);
    return {
      rows: fakePg.events
        .filter(
          (event) =>
            event.run_id === runId &&
            event.seq >= fromSeq &&
            (toSeq === undefined || event.seq <= toSeq),
        )
        .sort((first, second) => first.seq - second.seq)
        .slice(0, limit),
    };
  }
  if (query.startsWith("SELECT next_seq FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ next_seq: run.next_seq }] };
  }
  if (query.startsWith("SELECT run_id FROM events WHERE trace_id")) {
    const traceId = text(values[0]);
    const firstRunSequences = new Map<string, number>();
    fakePg.events.forEach((event, globalSeq) => {
      if (event.trace_id === traceId && !firstRunSequences.has(event.run_id)) {
        firstRunSequences.set(event.run_id, globalSeq);
      }
    });
    return {
      rows: [...firstRunSequences.entries()]
        .sort((first, second) => first[1] - second[1])
        .map(([run_id]) => ({ run_id })),
    };
  }
  if (query.startsWith("SELECT cursor FROM sink_cursors")) {
    const cursor = fakePg.sinkCursors.get(text(values[0]));
    return { rows: cursor === undefined ? [] : [{ cursor }] };
  }
  if (query.startsWith("INSERT INTO sink_cursors")) {
    const sinkId = text(values[0]);
    const cursor = number(values[1]);
    const previous = fakePg.sinkCursors.get(sinkId) ?? 0;
    if (cursor > previous) {
      fakePg.sinkCursors.set(sinkId, cursor);
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT global_seq, run_id, seq, ts, type")) {
    const cursor = number(values[0]);
    const limit = number(values[1]);
    return {
      rows: fakePg.events
        .filter(({ global_seq }) => global_seq > cursor)
        .sort((first, second) => first.global_seq - second.global_seq)
        .slice(0, limit),
    };
  }
  if (query.startsWith("SELECT runs.run_id")) {
    const continuationOf = values[0] === null ? undefined : text(values[0]);
    const status = values[1] === null ? undefined : text(values[1]);
    const createdAt = values[2] === null ? undefined : number(values[2]);
    const runId = values[3] === null ? undefined : text(values[3]);
    const limit = number(values[4]);
    const continuations = new Set(
      fakePg.events
        .filter(
          (event) => event.type === "run_created" && event.meta.continuationOf === continuationOf,
        )
        .map(({ run_id }) => run_id),
    );
    return {
      rows: [...fakePg.runs.values()]
        .filter(
          (run) =>
            (continuationOf === undefined || continuations.has(run.run_id)) &&
            (status === undefined || run.status === status) &&
            (createdAt === undefined ||
              run.created_at < createdAt ||
              (run.created_at === createdAt && run.run_id > (runId ?? ""))),
        )
        .sort((first, second) => {
          const createdAtOrder = second.created_at - first.created_at;
          return createdAtOrder !== 0 ? createdAtOrder : first.run_id.localeCompare(second.run_id);
        })
        .slice(0, limit)
        .map((run) => ({
          run_id: run.run_id,
          created_at: run.created_at,
          status: run.status,
          last_seq: run.next_seq - 1,
          last_ts: run.last_ts,
        })),
    };
  }
  if (query.startsWith("SELECT run_id, created_at, status, next_seq - 1 AS last_seq")) {
    const run = fakePg.runs.get(text(values[0]));
    return {
      rows:
        run === undefined
          ? []
          : [
              {
                run_id: run.run_id,
                created_at: run.created_at,
                status: run.status,
                last_seq: run.next_seq - 1,
                last_ts: run.last_ts,
              },
            ],
    };
  }
  throw new Error("Unexpected SQL statement");
}

beforeEach(() => {
  fakePg.runs.clear();
  fakePg.events.length = 0;
  fakePg.sinkCursors.clear();
  fakePg.snapshots.length = 0;
  fakePg.approvalNotifications.clear();
  fakePg.confirmationStates.clear();
  fakePg.idempotencyKeys.clear();
  transactionBackup = undefined;
  fakePg.schemaInitialized = false;
  fakePg.migrationHistory.clear();
  fakePg.encryptionValue = "";
  fakePg.notificationListeners.clear();
  fakePg.listenerEndListeners.clear();
  fakePg.listenerListenCount = 0;
  fakePg.terminalChecks = 0;
  fakePg.handler = fakeQuery;
  fakePg.connectErrorCode = "ECONNREFUSED";
  fakePg.shouldFailConnect = false;
});

const conformanceKeyId = "postgres-mock-conformance-key";
const conformanceKey = new Uint8Array(32).fill(13);
const keyProvider: KeyProvider = {
  currentKeyId: () => conformanceKeyId,
  getKey: (keyId) => {
    if (keyId !== conformanceKeyId) {
      return Promise.reject(
        Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
      );
    }
    return Promise.resolve(Uint8Array.from(conformanceKey));
  },
};
const contentCodec = new AesGcmContentCodec(keyProvider);

runEventStoreConformance(
  "MockPostgresEventStore",
  () => {
    const store = new PostgresEventStore(
      "postgresql://harness@localhost/harness",
      {},
      contentCodec,
    );
    return Promise.resolve({ store, cleanup: () => store.close() });
  },
  { supportsFileReopen: false },
);

it("validates Postgres idempotency claims before querying", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  const validRunId = Id.parse("00000000000000000000000001");
  try {
    await expect(store.claimIdempotencyKey("invalid", validRunId, 10)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await expect(store.claimIdempotencyKey("a".repeat(64), validRunId, -1)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
  } finally {
    await store.close();
  }
});

it("resumes encrypted Postgres event and snapshot rotation", async () => {
  let currentKeyId = "key-a";
  const rotationKeys = new Map([
    ["key-a", new Uint8Array(32).fill(71)],
    ["key-b", new Uint8Array(32).fill(72)],
  ]);
  const rotationProvider: KeyProvider = {
    currentKeyId: () => currentKeyId,
    getKey: (keyId) => {
      const key = rotationKeys.get(keyId);
      return key === undefined
        ? Promise.reject(
            Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
          )
        : Promise.resolve(Uint8Array.from(key));
    },
  };
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const snapshotId = builders.nextRunId();
  const snapshot = builders.snapshot(runId, snapshotId, 1);
  const store = new PostgresEventStore(
    "postgresql://harness@localhost/harness",
    {},
    new AesGcmContentCodec(rotationProvider),
  );
  try {
    await store.appendWithSnapshot(
      runId,
      [
        builders.runCreated(runId),
        builders.modelRequest(runId, "synthetic rotated content"),
        builders.checkpointWritten(runId, snapshotId, 1),
      ],
      0,
      snapshot,
    );
    currentKeyId = "key-b";
    const first = await store.reencryptBatch({ targetKeyId: currentKeyId, limit: 1 });
    expect(first.processed).toBe(1);
    expect(first.nextCursor).toBeDefined();
    await expect(store.countRowsByKey()).resolves.toContainEqual({ keyId: "key-a", count: 3 });
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events).toMatchObject([
      { seq: 0 },
      {
        seq: 1,
        messages: [{ role: "user", parts: [{ type: "text", text: "synthetic rotated content" }] }],
      },
      { seq: 2 },
    ]);

    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const batch = await store.reencryptBatch({
        targetKeyId: currentKeyId,
        limit: 1,
        afterCursor: cursor,
      });
      cursor = batch.nextCursor;
    }

    await expect(store.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 4 }]);
    await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
    await expect(store.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
      processed: 0,
    });
  } finally {
    await store.close();
  }
});

it("rejects invalid connection and pool configuration", () => {
  expect(() => new PostgresEventStore("invalid")).toThrow(
    "Invalid Postgres event-store configuration",
  );
  expect(
    () => new PostgresEventStore("postgresql://harness@localhost/harness", { schema: "bad;drop" }),
  ).toThrow("Invalid Postgres event-store configuration");
});

it("checks pending migrations without applying schema changes when requested", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness", {
    skipMigrations: true,
  });

  await expect(store.listRuns({ limit: 1 })).rejects.toMatchObject({
    code: "schema_migration_pending",
  });
  expect(fakePg.schemaInitialized).toBe(false);
  expect(fakePg.migrationHistory.size).toBe(0);
  await store.close();
});

it("validates encryption metadata without writing in read-only mode", async () => {
  const runId = createEventBuilders().nextRunId();
  const initial = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(initial.head(runId)).resolves.toBe(0);
  await initial.close();

  fakePg.encryptionValue = "";
  const readOnly = new PostgresEventStore("postgresql://harness@localhost/harness", {
    skipMigrations: true,
  });
  await expect(readOnly.listRuns({ limit: 1 })).resolves.toEqual({ runs: [] });
  expect(fakePg.encryptionValue).toBe("");
  await readOnly.close();
});

it("rejects all Postgres mutations through a read-only store", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const initial = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(initial.head(runId)).resolves.toBe(0);
  await initial.close();

  const readOnly = new PostgresEventStore("postgresql://harness@localhost/harness", {
    skipMigrations: true,
  });
  const snapshotId = builders.nextRunId();
  const snapshot = builders.snapshot(runId, snapshotId, 1);
  const operations = [
    readOnly.append(runId, [builders.runCreated(runId)], 0),
    readOnly.appendWithSnapshot(
      runId,
      [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 1)],
      0,
      snapshot,
    ),
    readOnly.deleteRun(runId),
    readOnly.ackOutbox(Code.parse("readonly.test"), 1),
    readOnly.claimApprovalNotification(builders.nextRunId(), runId, 1, 1),
    readOnly.markApprovalNotificationSent(builders.nextRunId(), runId, 1, 2),
    readOnly.releaseApprovalNotification(builders.nextRunId(), runId, 1),
  ];

  for (const operation of operations) {
    await expect(operation).rejects.toMatchObject({ code: "store_read_only" });
  }
  expect(fakePg.runs.size).toBe(0);
  expect(fakePg.events).toHaveLength(0);
  await readOnly.close();
});

it("checks existing encryption metadata during read-only initialization", async () => {
  const initial = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(initial.head(createEventBuilders().nextRunId())).resolves.toBe(0);
  await initial.close();

  fakePg.encryptionValue = "true";
  const readOnly = new PostgresEventStore("postgresql://harness@localhost/harness", {
    skipMigrations: true,
  });
  await expect(readOnly.head(createEventBuilders().nextRunId())).rejects.toMatchObject({
    code: "store_encryption_mismatch",
  });
  await readOnly.close();
});

it("preserves encryption mismatch errors during initialization", async () => {
  fakePg.encryptionValue = "true";
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");

  await expect(store.head(createEventBuilders().nextRunId())).rejects.toMatchObject({
    code: "store_encryption_mismatch",
  });
  await store.close();
});

it("normalizes metadata initialization failures and returns the pool connection", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.handler = (sql, values) => {
    if (sql.startsWith("SELECT metadata_value FROM store_metadata")) {
      throw new Error("synthetic metadata failure");
    }
    return fakeQuery(sql, values);
  };

  await expect(store.head(createEventBuilders().nextRunId())).rejects.toMatchObject({
    code: "store_unavailable",
  });
  await store.close();
});

it("skips schema DDL when another pool already initialized the schema", async () => {
  const runId = createEventBuilders().nextRunId();
  const first = new PostgresEventStore("postgresql://harness@localhost/harness");
  const second = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(Promise.all([first.head(runId), second.head(runId)])).resolves.toEqual([0, 0]);
  await Promise.all([first.close(), second.close()]);
});

it.each(["ENOTFOUND", "EAI_AGAIN"])(
  "maps %s connection failures to typed store errors",
  async (code) => {
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const failedStore = new PostgresEventStore("postgresql://harness@localhost/harness");
    fakePg.connectErrorCode = code;
    fakePg.shouldFailConnect = true;
    await expect(failedStore.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await failedStore.close();
  },
);

it("retries initialization after a transient connection failure", async () => {
  const runId = createEventBuilders().nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.shouldFailConnect = true;
  await expect(store.head(runId)).rejects.toBeInstanceOf(StoreUnavailableError);

  fakePg.shouldFailConnect = false;
  await expect(store.head(runId)).resolves.toBe(0);
  await store.close();
});

it("fails a watch when the dedicated listener cannot LISTEN", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.handler = (sql, values) => {
    if (sql === "LISTEN harness_events") {
      throw new Error("synthetic listen failure");
    }
    return fakeQuery(sql, values);
  };
  const controller = new AbortController();
  const iterator = store
    .watch(createEventBuilders().nextRunId(), { fromSeq: 0, signal: controller.signal })
    [Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toMatchObject({ code: "store_unavailable" });
  await store.close();
});

it.each([
  ["missing run", false],
  ["non-terminal head", true],
])("checks terminal state for a %s", async (_label, createRun) => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  if (createRun) {
    await store.append(runId, [builders.runCreated(runId)], 0);
  }
  const controller = new AbortController();
  const iterator = store
    .watch(runId, { fromSeq: createRun ? 1 : 0, signal: controller.signal })
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  try {
    await vi.waitFor(() => {
      expect(fakePg.terminalChecks).toBe(1);
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
  } finally {
    controller.abort();
    await iterator.return?.();
    await store.close();
  }
});

it("ignores UNLISTEN failure when closing the dedicated listener", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  await store.append(runId, [builders.runCreated(runId)], 0);
  const controller = new AbortController();
  const iterator = store
    .watch(runId, { fromSeq: 1, signal: controller.signal })
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  await vi.waitFor(() => {
    expect(fakePg.listenerListenCount).toBe(1);
  });
  fakePg.handler = (sql, values) => {
    if (sql === "UNLISTEN harness_events") {
      throw new Error("synthetic unlisten failure");
    }
    return fakeQuery(sql, values);
  };
  controller.abort();
  await expect(pending).resolves.toMatchObject({ done: true });
  await iterator.return?.();

  await expect(store.close()).resolves.toBeUndefined();
});

it("re-listens and catches up run changes missed while the listener was disconnected", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  await store.append(runId, [builders.runCreated(runId)], 0);
  const controller = new AbortController();
  const iterator = store
    .watch(runId, { fromSeq: 1, signal: controller.signal })
    [Symbol.asyncIterator]();
  const pendingEvent = iterator.next();
  try {
    await vi.waitFor(() => {
      expect(fakePg.listenerListenCount).toBe(1);
    });
    const disconnect = fakePg.listenerEndListeners.values().next().value;
    if (disconnect === undefined) {
      throw new Error("Expected a listener end handler");
    }
    disconnect();
    fakePg.notificationListeners.clear();
    await store.append(runId, [builders.modelRequest(runId)], 1);
    await vi.waitFor(() => {
      expect(fakePg.listenerListenCount).toBe(2);
    });

    await expect(pendingEvent).resolves.toMatchObject({
      done: false,
      value: { seq: 1, type: "model_request" },
    });
  } finally {
    controller.abort();
    await iterator.return?.();
    await store.close();
  }
});

it("does not map an event insert unique violation to a sequence conflict at the expected head", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  fakePg.shouldFailConnect = false;
  fakePg.connectErrorCode = "23505";
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.handler = (sql, values) => {
    if (sql.includes("WITH inserted_events")) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return fakeQuery(sql, values);
  };
  await expect(store.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
    StoreUnavailableError,
  );
  await store.close();
});

it("rolls back run deletion when one of its delete statements fails", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const snapshotId = builders.nextRunId();
  const snapshot = builders.snapshot(runId, snapshotId, 1);
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  await store.appendWithSnapshot(
    runId,
    [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 1)],
    0,
    snapshot,
  );
  await store.append(runId, [builders.runStatusChanged(runId, "pending", "completed")], 2);
  fakePg.handler = (sql, values) => {
    if (sql.includes("DELETE FROM snapshots WHERE run_id")) {
      throw new Error("synthetic delete failure");
    }
    return fakeQuery(sql, values);
  };

  await expect(store.deleteRun(runId)).rejects.toBeInstanceOf(StoreUnavailableError);
  await expect(store.head(runId)).resolves.toBe(3);
  await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
  await store.close();
});

it("maps malformed stored content to an unavailable-store error", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const codec: ContentCodec = {
    encrypted: false,
    encode: () => Promise.resolve({ blob: "encoded" }),
    decode: () => Promise.reject(new Error("decode failure")),
  };
  const store = new PostgresEventStore("postgresql://harness@localhost/harness", {}, codec);
  await store.append(runId, [builders.runCreated(runId)], 0);
  await expect(async () => {
    for await (const event of store.read(runId)) {
      expect(event.seq).toBe(0);
    }
  }).rejects.toBeInstanceOf(StoreUnavailableError);
  await store.close();
});

it("rejects malformed list cursors", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(store.listRuns({ limit: 1, cursor: "invalid" })).rejects.toMatchObject({
    code: "event_invalid",
  });
  await store.close();
});

it("filters Postgres run listings to direct continuations", async () => {
  const builders = createEventBuilders();
  const parentId = builders.nextRunId();
  const firstBranch = builders.nextRunId();
  const secondBranch = builders.nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  await store.append(parentId, [builders.runCreated(parentId)], 0);
  await store.append(
    firstBranch,
    [{ ...builders.runCreated(firstBranch), continuationOf: parentId }],
    0,
  );
  await store.append(
    secondBranch,
    [{ ...builders.runCreated(secondBranch), continuationOf: parentId }],
    0,
  );

  await expect(store.listRuns({ continuationOf: parentId, limit: 10 })).resolves.toMatchObject({
    runs: [{ runId: secondBranch }, { runId: firstBranch }],
  });
  await store.close();
});
