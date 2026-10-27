// SPDX-License-Identifier: Apache-2.0
import { ContractError, Id } from "@rovinos/schemas";
import { createEventBuilders } from "./testing/testing.js";
import {
  ContentDecryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  StoreUnavailableError,
} from "./errors.js";
import {
  decodeSnapshot,
  encodeSnapshot,
  JsonContentCodec,
  snapshotKeep,
  validateSnapshotAppend,
} from "./codec.js";
import type { ContentCodec, SnapshotRow } from "./codec.js";
import { describe, expect, it } from "vitest";

const builders = createEventBuilders();
const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000002");
const snapshotId = Id.parse("00000000000000000000000003");

describe("store content codec", () => {
  it("applies snapshot retention defaults and rejects invalid retention options", () => {
    expect(snapshotKeep()).toBe(5);
    expect(() => snapshotKeep({ snapshotKeep: 0 })).toThrow(TypeError);
  });

  it("validates checkpoint identity, sequence, and single-checkpoint batches", () => {
    const snapshot = builders.snapshot(runId, snapshotId, 1);
    const events = [builders.runCreated(runId), builders.checkpointWritten(runId, snapshotId, 1)];
    expect(validateSnapshotAppend(runId, events, 0, snapshot)).toEqual(snapshot);
    expect(() => validateSnapshotAppend(otherRunId, events, 0, snapshot)).toThrow(InvalidEventError);
    expect(() => validateSnapshotAppend(runId, [builders.runCreated(runId)], 0, snapshot)).toThrow(
      InvalidEventError,
    );
    expect(() =>
      validateSnapshotAppend(
        runId,
        [builders.checkpointWritten(runId, otherRunId, 1)],
        0,
        snapshot,
      ),
    ).toThrow(InvalidEventError);
    expect(() =>
      validateSnapshotAppend(runId, [builders.checkpointWritten(runId, snapshotId, 2)], 0, snapshot),
    ).toThrow(InvalidEventError);
    expect(() =>
      validateSnapshotAppend(runId, [builders.checkpointWritten(runId, snapshotId, 1)], 0, {
        ...snapshot,
        atSeq: 2,
      }),
    ).toThrow(InvalidEventError);
    expect(() =>
      validateSnapshotAppend(runId, events, 0, {} as typeof snapshot),
    ).toThrow(InvalidEventError);
  });

  it("encodes and decodes snapshot content while mapping malformed rows to store errors", async () => {
    const snapshot = builders.snapshot(runId, snapshotId, 1);
    const codec = new JsonContentCodec();
    const encoded = await encodeSnapshot(codec, snapshot);
    const row: SnapshotRow = {
      ...encoded,
      meta_json: encoded.meta_json,
    };

    await expect(decodeSnapshot(codec, row)).resolves.toEqual(snapshot);
    await expect(decodeSnapshot(codec, { ...row, at_seq: "unsafe" })).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await expect(
      decodeSnapshot(codec, { ...row, meta_json: { unexpected: "metadata" } }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);

    const decryptFailure: ContentCodec = {
      encrypted: true,
      encode: () => Promise.resolve({ blob: "" }),
      decode: () => Promise.reject(new ContentDecryptFailedError()),
    };
    await expect(decodeSnapshot(decryptFailure, row)).rejects.toBeInstanceOf(
      ContentDecryptFailedError,
    );
    const missingKey: ContentCodec = {
      ...decryptFailure,
      decode: () => Promise.reject(new KeyNotFoundError()),
    };
    await expect(decodeSnapshot(missingKey, row)).rejects.toBeInstanceOf(KeyNotFoundError);
    const unavailable: ContentCodec = {
      ...decryptFailure,
      decode: () => Promise.reject(new Error("synthetic decoder failure")),
    };
    await expect(decodeSnapshot(unavailable, row)).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it("maps invalid content JSON, unsupported JSON values, and oversized payloads to contract errors", async () => {
    const codec = new JsonContentCodec();
    const context = { runId, seq: 0 };
    await expect(codec.decode(context, "{")).rejects.toBeInstanceOf(ContractError);
    await expect(
      codec.encode(context, { toJSON: () => undefined }),
    ).rejects.toBeInstanceOf(ContractError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(codec.encode(context, circular)).rejects.toBeInstanceOf(ContractError);
    await expect(codec.encode(context, { value: "x".repeat(1_048_577) })).rejects.toBeInstanceOf(
      ContractError,
    );
  });
});
