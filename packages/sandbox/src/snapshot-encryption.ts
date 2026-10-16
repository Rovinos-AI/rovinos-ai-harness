// SPDX-License-Identifier: Apache-2.0
import { aesGcmDecrypt, aesGcmEncrypt } from "@harness/crypto";
import { Code } from "@harness/schemas";
import type { Id, KeyProvider } from "@harness/schemas";
import { WorkspaceSnapshotError } from "./snapshot-archive.js";

const ENCRYPTION_HEADER = Buffer.from("WSENC01", "ascii");

/** Encrypts compressed workspace bytes with AES-256-GCM when enabled. */
export async function encryptWorkspaceArchive(
  archive: Buffer,
  options: {
    readonly runId: Id;
    readonly snapshotId: Id;
    readonly enabled: boolean;
    readonly provider?: KeyProvider;
  },
): Promise<Buffer> {
  const { runId, snapshotId, enabled, provider } = options;
  if (!enabled) {
    return archive;
  }
  if (provider === undefined) {
    throw new WorkspaceSnapshotError();
  }
  let key: Buffer | undefined;
  try {
    const keyId = Code.parse(provider.currentKeyId());
    key = Buffer.from(await provider.getKey(keyId));
    const encrypted = aesGcmEncrypt(key, archive, Buffer.from(`${runId}:${snapshotId}`));
    const encodedKeyId = Buffer.from(keyId, "utf8");
    return Buffer.concat([
      ENCRYPTION_HEADER,
      Buffer.from([encodedKeyId.byteLength]),
      encodedKeyId,
      encrypted,
    ]);
  } catch {
    throw new WorkspaceSnapshotError();
  } finally {
    key?.fill(0);
  }
}

/** Verifies and decrypts an encrypted archive envelope when present. */
export async function decryptWorkspaceArchive(
  storedBytes: Buffer,
  runId: Id,
  snapshotId: Id,
  provider?: KeyProvider,
): Promise<Buffer> {
  if (!storedBytes.subarray(0, ENCRYPTION_HEADER.byteLength).equals(ENCRYPTION_HEADER)) {
    return Buffer.from(storedBytes);
  }
  const keyIdLength = storedBytes[ENCRYPTION_HEADER.byteLength];
  if (keyIdLength === undefined || keyIdLength < 1) {
    throw new WorkspaceSnapshotError();
  }
  const keyOffset = ENCRYPTION_HEADER.byteLength + 1;
  const keyId = Code.safeParse(
    storedBytes.subarray(keyOffset, keyOffset + keyIdLength).toString("utf8"),
  );
  if (!keyId.success || provider === undefined) {
    throw new WorkspaceSnapshotError();
  }
  let key: Buffer | undefined;
  try {
    key = Buffer.from(await provider.getKey(keyId.data));
    return Buffer.from(
      aesGcmDecrypt(
        key,
        storedBytes.subarray(keyOffset + keyIdLength),
        Buffer.from(`${runId}:${snapshotId}`),
      ),
    );
  } catch {
    throw new WorkspaceSnapshotError();
  } finally {
    key?.fill(0);
  }
}
