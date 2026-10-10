// SPDX-License-Identifier: Apache-2.0
import { Id, type KeyProvider } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { AesGcmContentCodec } from "./aes-gcm-codec.js";
import { ContentEncryptFailedError, KeyNotFoundError } from "./errors.js";

const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000002");
const keyId = "test-key-v1";
const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);

class TestKeyProvider implements KeyProvider {
  constructor(
    private readonly keys: ReadonlyMap<string, Uint8Array>,
    private readonly currentId = keyId,
  ) {}

  currentKeyId(): string {
    return this.currentId;
  }

  getKey(id: string): Promise<Uint8Array> {
    const resolved = this.keys.get(id);
    if (resolved === undefined) {
      return Promise.reject(new KeyNotFoundError());
    }
    return Promise.resolve(Uint8Array.from(resolved));
  }
}

function provider(keys: ReadonlyMap<string, Uint8Array> = new Map([[keyId, key]])): KeyProvider {
  return new TestKeyProvider(keys);
}

describe("AesGcmContentCodec", () => {
  it("round-trips content with the active key identifier", async () => {
    const codec = new AesGcmContentCodec(provider());
    const content = { messages: [{ text: "synthetic content" }] };
    const encoded = await codec.encode({ runId, seq: 3 }, content);

    expect(encoded.keyId).toBe(keyId);
    await expect(codec.decode({ runId, seq: 3 }, encoded.blob, encoded.keyId)).resolves.toEqual(
      content,
    );
  });

  it("uses a fresh IV for identical content", async () => {
    const codec = new AesGcmContentCodec(provider());
    const context = { runId, seq: 3 };

    const first = await codec.encode(context, { value: "same" });
    const second = await codec.encode(context, { value: "same" });

    expect(first.blob).not.toBe(second.blob);
  });

  it("rejects modified blobs and non-canonical base64", async () => {
    const codec = new AesGcmContentCodec(provider());
    const encoded = await codec.encode({ runId, seq: 3 }, { value: "secret" });
    const tampered = Buffer.from(encoded.blob, "base64");
    const ciphertextByte = tampered.at(12);
    if (ciphertextByte === undefined) {
      throw new Error("Expected encrypted content");
    }
    tampered[12] = ciphertextByte ^ 1;

    await expect(
      codec.decode({ runId, seq: 3 }, tampered.toString("base64"), keyId),
    ).rejects.toMatchObject({ code: "content_decrypt_failed" });
    await expect(codec.decode({ runId, seq: 3 }, "invalid", keyId)).rejects.toMatchObject({
      code: "content_decrypt_failed",
    });
  });

  it("binds event and snapshot blobs to their run, sequence, and purpose", async () => {
    const codec = new AesGcmContentCodec(provider());
    const eventContext = { runId, seq: 3 };
    const encodedEvent = await codec.encode(eventContext, { value: "event" });
    const snapshotContext = { runId, seq: 3, purpose: "snapshot" as const };
    const encodedSnapshot = await codec.encode(snapshotContext, { value: "snapshot" });

    await expect(
      codec.decode({ runId: otherRunId, seq: 3 }, encodedEvent.blob, keyId),
    ).rejects.toMatchObject({ code: "content_decrypt_failed" });
    await expect(codec.decode({ runId, seq: 4 }, encodedEvent.blob, keyId)).rejects.toMatchObject({
      code: "content_decrypt_failed",
    });
    await expect(codec.decode(eventContext, encodedSnapshot.blob, keyId)).rejects.toMatchObject({
      code: "content_decrypt_failed",
    });
    await expect(codec.decode(snapshotContext, encodedSnapshot.blob, keyId)).resolves.toEqual({
      value: "snapshot",
    });
  });

  it("rejects an incorrect key and reports unavailable historical keys", async () => {
    const codec = new AesGcmContentCodec(provider());
    const encoded = await codec.encode({ runId, seq: 3 }, { value: "secret" });
    const wrongKeyCodec = new AesGcmContentCodec(provider(new Map([[keyId, otherKey]])));

    await expect(
      wrongKeyCodec.decode({ runId, seq: 3 }, encoded.blob, keyId),
    ).rejects.toMatchObject({ code: "content_decrypt_failed" });
    await expect(
      codec.decode({ runId, seq: 3 }, encoded.blob, "missing-key"),
    ).rejects.toMatchObject({ code: "key_not_found" });
    await expect(codec.decode({ runId, seq: 3 }, encoded.blob)).rejects.toMatchObject({
      code: "content_decrypt_failed",
    });
  });

  it("rejects invalid key material and hides key-provider errors", async () => {
    const invalidKeyProvider: KeyProvider = {
      currentKeyId: () => keyId,
      getKey: () => Promise.resolve(new Uint8Array(16)),
    };
    await expect(
      new AesGcmContentCodec(invalidKeyProvider).encode({ runId, seq: 3 }, { value: "secret" }),
    ).rejects.toBeInstanceOf(ContentEncryptFailedError);

    const failedKeyProvider: KeyProvider = {
      currentKeyId: () => keyId,
      getKey: () => Promise.reject(new Error("synthetic provider detail")),
    };
    await expect(
      new AesGcmContentCodec(failedKeyProvider).decode({ runId, seq: 3 }, "invalid", keyId),
    ).rejects.toMatchObject({
      code: "content_decrypt_failed",
      message: "Content decryption failed",
    });
  });
});
