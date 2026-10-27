// SPDX-License-Identifier: Apache-2.0
import { Code, Id, type KeyProvider } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { decryptWorkspaceArchive, encryptWorkspaceArchive } from "./snapshot-encryption.js";

const runId = Id.parse("00000000000000000000000001");
const snapshotId = Id.parse("00000000000000000000000002");
const archive = Buffer.from("synthetic archive");

function provider(
  currentKeyId: () => string = () => "test_key",
  getKey: KeyProvider["getKey"] = () => Promise.resolve(new Uint8Array(32).fill(5)),
): KeyProvider {
  return { currentKeyId, getKey };
}

describe("workspace snapshot encryption", () => {
  it("fails closed when encryption is enabled without usable key material", async () => {
    await expect(
      encryptWorkspaceArchive(archive, {
        runId,
        snapshotId,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
    await expect(
      encryptWorkspaceArchive(archive, {
        runId,
        snapshotId,
        enabled: true,
        provider: provider(() => {
          throw new Error("synthetic current-key failure");
        }),
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
    await expect(
      encryptWorkspaceArchive(archive, {
        runId,
        snapshotId,
        enabled: true,
        provider: provider(
          () => "test_key",
          () => Promise.reject(new Error("synthetic key lookup failure")),
        ),
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
    await expect(
      encryptWorkspaceArchive(archive, {
        runId,
        snapshotId,
        enabled: true,
        provider: provider(
          () => "test_key",
          () => Promise.resolve(new Uint8Array(12)),
        ),
      }),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
  });

  it("rejects malformed encrypted envelopes and unavailable or incorrect keys", async () => {
    const header = Buffer.from("WSENC01", "ascii");
    const emptyKeyId = Buffer.concat([header, Buffer.from([0])]);
    await expect(decryptWorkspaceArchive(emptyKeyId, runId, snapshotId)).rejects.toMatchObject({
      code: "workspace_snapshot_invalid",
    });

    const invalidKeyId = Buffer.concat([
      header,
      Buffer.from([Code.parse("test_key").length]),
      Buffer.from("not a valid key"),
    ]);
    await expect(
      decryptWorkspaceArchive(invalidKeyId, runId, snapshotId, provider()),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });

    const encrypted = await encryptWorkspaceArchive(archive, {
      runId,
      snapshotId,
      enabled: true,
      provider: provider(),
    });
    await expect(decryptWorkspaceArchive(encrypted, runId, snapshotId)).rejects.toMatchObject({
      code: "workspace_snapshot_invalid",
    });
    await expect(
      decryptWorkspaceArchive(
        encrypted,
        runId,
        snapshotId,
        provider(
          () => "test_key",
          () => Promise.reject(new Error("synthetic key lookup failure")),
        ),
      ),
    ).rejects.toMatchObject({ code: "workspace_snapshot_invalid" });
  });
});
