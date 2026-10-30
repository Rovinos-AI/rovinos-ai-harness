// SPDX-License-Identifier: Apache-2.0
import {
  ContractError,
  Id,
  parseJson,
  upcastSnapshot,
  type NewEvent,
  type Snapshot,
} from "@rovinos/schemas";
import { z } from "zod";
import {
  ContentDecryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  StoreUnavailableError,
} from "./errors.js";
import { snapshotStoreOptionsSchema, type SnapshotStoreOptions } from "./types.js";

const contentSchema = z.record(z.string(), z.json());
export const MAX_CONTENT_BYTES = 1_048_576;

function validateContentSize(blob: string): void {
  if (Buffer.byteLength(blob, "utf8") > MAX_CONTENT_BYTES) {
    throw new ContractError([{ path: [], code: "size_limit_exceeded" }]);
  }
}

/** Context binding a content encoding to its event. */
export interface ContentCodecContext {
  /** Event's run identifier. */
  runId: Id;
  /** Event's sequence number. */
  seq: number;
  /** Set when encoding or decoding snapshot content instead of event content. */
  purpose?: "snapshot";
}

/** Encoded event content and optional encryption key identifier. */
export interface EncodedContent {
  /** Serialized or encrypted content blob. */
  blob: string;
  /** Key identifier used for encryption, when applicable. */
  keyId?: string;
}

/** Encodes and decodes event content independently of event metadata. */
export interface ContentCodec {
  /** Whether this codec encrypts persisted content. */
  readonly encrypted: boolean;
  /**
   * Encode content for an event.
   *
   * @param ctx Event identity used by contextual codecs.
   * @param content Content-classified event fields.
   * @param targetKeyId Optional key identifier for explicit re-encryption.
   * @returns The encoded blob and optional key identifier.
   */
  encode(
    ctx: ContentCodecContext,
    content: Record<string, unknown>,
    targetKeyId?: string,
  ): Promise<EncodedContent>;
  /**
   * Decode content for an event.
   *
   * @param ctx Event identity used by contextual codecs.
   * @param blob Encoded content blob.
   * @param keyId Optional key identifier from storage.
   * @returns Content-classified event fields.
   */
  decode(ctx: ContentCodecContext, blob: string, keyId?: string): Promise<Record<string, unknown>>;
}

const snapshotMetaSchema = z.record(z.string(), z.json());

/** Validate snapshot retention options and apply the default. */
export function snapshotKeep(options: SnapshotStoreOptions = {}): number {
  const parsed = snapshotStoreOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new TypeError("Invalid snapshot retention configuration");
  }
  return parsed.data.snapshotKeep;
}

/** Snapshot fields prepared for insertion alongside its checkpoint event. */
export interface EncodedSnapshot {
  snapshot_id: string;
  run_id: string;
  at_seq: number;
  created_at: number;
  meta_json: string;
  content_blob: string;
  key_id: string | null;
}

/** Validate that a checkpoint batch and snapshot describe the same checkpoint. */
export function validateSnapshotAppend(
  runId: Id,
  events: readonly NewEvent[],
  expectedSeq: number,
  snapshot: Snapshot,
): Snapshot {
  let parsedSnapshot: Snapshot;
  try {
    parsedSnapshot = upcastSnapshot(snapshot);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new InvalidEventError(
        error.issues.map(({ path }) =>
          path.filter(
            (part): part is string | number => typeof part === "string" || typeof part === "number",
          ),
        ),
      );
    }
    throw new InvalidEventError([[]]);
  }
  if (parsedSnapshot.runId !== runId) {
    throw new InvalidEventError([["runId"]]);
  }

  const checkpoints = events.filter(
    (event): event is Extract<NewEvent, { type: "checkpoint_written" }> =>
      event.type === "checkpoint_written",
  );
  if (checkpoints.length !== 1) {
    throw new InvalidEventError([["checkpoint_written"]]);
  }
  const checkpoint = checkpoints[0];
  if (checkpoint?.checkpointId !== parsedSnapshot.snapshotId) {
    throw new InvalidEventError([["snapshotId"]]);
  }
  if (checkpoint.atSeq !== parsedSnapshot.atSeq) {
    throw new InvalidEventError([["atSeq"]]);
  }
  const checkpointIndex = events.findIndex((event) => event.type === "checkpoint_written");
  if (checkpointIndex < 0 || parsedSnapshot.atSeq > expectedSeq + checkpointIndex) {
    throw new InvalidEventError([["atSeq"]]);
  }
  return parsedSnapshot;
}

/** Encode only snapshot content; identity, trace, and timestamps remain metadata. */
export async function encodeSnapshot(
  codec: ContentCodec,
  snapshot: Snapshot,
): Promise<EncodedSnapshot> {
  const encoded = await codec.encode(
    { runId: snapshot.runId, seq: snapshot.atSeq, purpose: "snapshot" },
    { context: snapshot.context, plan: snapshot.plan },
  );
  const meta = {
    v: snapshot.v,
    traceparent: snapshot.traceparent,
    ...(snapshot.workspaceRef === undefined ? {} : { workspaceRef: snapshot.workspaceRef }),
  };
  return {
    snapshot_id: snapshot.snapshotId,
    run_id: snapshot.runId,
    at_seq: snapshot.atSeq,
    created_at: snapshot.createdAt,
    meta_json: JSON.stringify(meta),
    content_blob: encoded.blob,
    key_id: encoded.keyId ?? null,
  };
}

/** Database representation read when retrieving a stored snapshot. */
export interface SnapshotRow {
  snapshot_id: string;
  run_id: string;
  at_seq: number | string;
  created_at: number | string;
  meta_json: unknown;
  content_blob: string;
  key_id: string | null;
}

/** Decode and validate a snapshot row without exposing persisted content on failure. */
export async function decodeSnapshot(codec: ContentCodec, row: SnapshotRow): Promise<Snapshot> {
  try {
    const meta =
      typeof row.meta_json === "string"
        ? parseJson(snapshotMetaSchema, row.meta_json)
        : snapshotMetaSchema.parse(row.meta_json);
    const atSeq = Number(row.at_seq);
    const createdAt = Number(row.created_at);
    if (!Number.isSafeInteger(atSeq) || !Number.isSafeInteger(createdAt)) {
      throw new StoreUnavailableError();
    }
    const content = await codec.decode(
      { runId: Id.parse(row.run_id), seq: atSeq, purpose: "snapshot" },
      row.content_blob,
      row.key_id ?? undefined,
    );
    if (Object.keys(meta).some((key) => Object.hasOwn(content, key))) {
      throw new StoreUnavailableError();
    }
    return upcastSnapshot({
      snapshotId: row.snapshot_id,
      runId: row.run_id,
      atSeq,
      createdAt,
      ...meta,
      ...content,
    });
  } catch (error) {
    if (error instanceof ContentDecryptFailedError || error instanceof KeyNotFoundError) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}

/** JSON serialization codec for event content when encryption is not configured. */
export class JsonContentCodec implements ContentCodec {
  /** Identifies this codec as plaintext for store metadata checks. */
  readonly encrypted = false;

  /** {@inheritDoc ContentCodec.encode} */
  encode(_ctx: ContentCodecContext, content: Record<string, unknown>): Promise<EncodedContent> {
    return Promise.resolve().then(() => {
      let blob: unknown;
      try {
        blob = JSON.stringify(content);
      } catch {
        throw new ContractError([{ path: [], code: "json_encode_failed" }]);
      }
      if (typeof blob !== "string") {
        throw new ContractError([{ path: [], code: "json_encode_failed" }]);
      }
      validateContentSize(blob);
      return { blob };
    });
  }

  /** {@inheritDoc ContentCodec.decode} */
  decode(
    _ctx: ContentCodecContext,
    blob: string,
    _keyId?: string,
  ): Promise<Record<string, unknown>> {
    return Promise.resolve().then(() =>
      parseJson(contentSchema, blob, { maxBytes: MAX_CONTENT_BYTES }),
    );
  }
}
