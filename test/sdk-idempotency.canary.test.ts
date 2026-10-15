// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { HarnessConfigSchema } from "@harness/config";
import type { ModelPort } from "@harness/core";
import { createHarness } from "@harness/sdk";
import { Code, FakeClock, Id, SequentialIdGenerator } from "@harness/schemas";
import { SqliteEventStore } from "@harness/store";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const fakeModel: ModelPort = {
  complete: () =>
    Promise.resolve({
      parts: [{ type: "text", text: "synthetic completion" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      provider: Code.parse("test"),
      model: Code.parse("test-model"),
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
      providerBlobs: null,
    }),
};

it("stores only a SHA-256 digest of the SDK idempotency key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-sdk-idempotency-canary-"));
  const path = join(directory, "events.sqlite");
  const rawKey = `synthetic-idempotency-canary-${randomBytes(16).toString("hex")}`;
  // Mirrors the SDK: a domain-separated SHA-256 of the raw key.
  const keyHash = createHash("sha256")
    .update("harness/sdk/idempotency/v1\0")
    .update(rawKey)
    .digest("hex");
  const store = new SqliteEventStore(path);
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    harness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store,
        clock: new FakeClock(10_000),
        ids: new SequentialIdGenerator(),
        transientVault: true,
        model: fakeModel,
      },
    });
    const { runId } = await harness.startRun({
      goal: "Synthetic idempotency privacy check",
      idempotencyKey: rawKey,
    });
    const database = new Database(path, { readonly: true });
    try {
      const stored = {
        keys: database
          .prepare<[], { key_hash: string; run_id: string }>(
            "SELECT key_hash, run_id FROM idempotency_keys",
          )
          .all(),
        events: database
          .prepare<[string], { meta_json: string; content_blob: Uint8Array | null }>(
            "SELECT meta_json, content_blob FROM events WHERE run_id = ?",
          )
          .all(Id.parse(runId)),
      };
      const serialized = JSON.stringify(stored);
      expect(stored.keys).toContainEqual({ key_hash: keyHash, run_id: runId });
      expect(serialized).not.toContain(rawKey);
    } finally {
      database.close();
    }
  } finally {
    await harness?.close();
    if (harness === undefined) {
      await store.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
