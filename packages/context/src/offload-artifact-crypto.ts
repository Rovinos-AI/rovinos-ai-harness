// SPDX-License-Identifier: Apache-2.0
import { aesGcmDecrypt, aesGcmEncrypt } from "@rovinos/crypto";
import { Code, KEY_PROVIDER_KEY_BYTES, type Id, type KeyProvider } from "@rovinos/schemas";
import { createHash } from "node:crypto";
import type { OffloadedHandle } from "./offload-schemas.js";

const MAGIC = Buffer.from("HRA1", "ascii");

/** Closed, content-free failure from MCP artifact encryption and decryption. */
export class OffloadArtifactCryptoError extends Error {
  constructor(
    readonly code:
      | "artifact_encrypt_failed"
      | "artifact_decrypt_failed"
      | "artifact_legacy_unsupported",
  ) {
    super(code);
  }
}

function artifactAad(runId: Id, handle: OffloadedHandle): Buffer {
  return Buffer.from(`harness/mcp-artifact/v1/${runId}/${handle}`, "utf8");
}

async function loadKey(provider: KeyProvider, keyId: string): Promise<Buffer> {
  try {
    const key = await provider.getKey(keyId);
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_PROVIDER_KEY_BYTES) {
      throw new Error("Invalid key.");
    }
    return Buffer.from(key);
  } catch {
    throw new OffloadArtifactCryptoError("artifact_decrypt_failed");
  }
}

/** Encrypts an artifact using the current key and binds it to its run and handle. */
export async function encryptOffloadArtifact(
  provider: KeyProvider,
  runId: Id,
  handle: OffloadedHandle,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  let keyId: string;
  try {
    keyId = Code.parse(provider.currentKeyId());
  } catch {
    throw new OffloadArtifactCryptoError("artifact_encrypt_failed");
  }
  let key: Buffer | undefined;
  let encrypted: Uint8Array | undefined;
  try {
    const rawKey = await provider.getKey(keyId);
    if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== KEY_PROVIDER_KEY_BYTES) {
      throw new Error("Invalid key.");
    }
    key = Buffer.from(rawKey);
    encrypted = aesGcmEncrypt(key, plaintext, artifactAad(runId, handle));
    const encodedKeyId = Buffer.from(keyId, "utf8");
    if (encodedKeyId.byteLength === 0 || encodedKeyId.byteLength > 255) {
      throw new Error("Invalid key identifier.");
    }
    return Uint8Array.from(
      Buffer.concat([
        MAGIC,
        Buffer.from([encodedKeyId.byteLength]),
        encodedKeyId,
        Buffer.from(encrypted),
      ]),
    );
  } catch {
    throw new OffloadArtifactCryptoError("artifact_encrypt_failed");
  } finally {
    key?.fill(0);
    encrypted?.fill(0);
  }
}

/** Decrypts a framed artifact, requiring its original run, handle, and key version. */
export async function decryptOffloadArtifact(
  provider: KeyProvider | undefined,
  runId: Id,
  handle: OffloadedHandle,
  stored: Uint8Array,
): Promise<Uint8Array> {
  if (
    stored.byteLength < MAGIC.byteLength + 1 ||
    !Buffer.from(stored.subarray(0, MAGIC.byteLength)).equals(MAGIC)
  ) {
    throw new OffloadArtifactCryptoError("artifact_legacy_unsupported");
  }
  const keyIdLength = stored[MAGIC.byteLength] ?? 0;
  const encryptedOffset = MAGIC.byteLength + 1 + keyIdLength;
  if (keyIdLength === 0 || encryptedOffset >= stored.byteLength || provider === undefined) {
    throw new OffloadArtifactCryptoError("artifact_decrypt_failed");
  }

  let keyId: string;
  try {
    keyId = Code.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        stored.subarray(MAGIC.byteLength + 1, encryptedOffset),
      ),
    );
  } catch {
    throw new OffloadArtifactCryptoError("artifact_decrypt_failed");
  }

  let key: Buffer | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    key = await loadKey(provider, keyId);
    plaintext = aesGcmDecrypt(
      key,
      stored.subarray(encryptedOffset),
      artifactAad(runId, handle),
    );
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    if (error instanceof OffloadArtifactCryptoError) {
      throw error;
    }
    throw new OffloadArtifactCryptoError("artifact_decrypt_failed");
  } finally {
    key?.fill(0);
  }
}

/** Returns the digest used by the plaintext artifact reference. */
export function offloadArtifactSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
