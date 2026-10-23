// SPDX-License-Identifier: Apache-2.0
import { PiiEventStore } from "@harness/pii";
import {
  Event as EventSchema,
  Id,
  RunConfigSchema,
  StoreConfigSchema,
  VaultConfigSchema,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { ExecSpecSchema } from "@harness/sandbox";
import { describe, expect, it, vi } from "vitest";
import { ResolvedRunSchema } from "./resolve.js";
import { buildReplayRuntime } from "./replay-runtime.js";

const runId = Id.parse("00000000000000000000000001");
const event = EventSchema.parse({
  runId,
  seq: 0,
  ts: 100,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: Id.parse("00000000000000000000000002"),
  type: "run_created",
  configHash: "c".repeat(64),
  policyVersion: "test",
});

describe("buildReplayRuntime", () => {
  it("uses isolated storage, retains the storage PII decorator, and blocks sandbox execution", async () => {
    const originalStore = new InMemoryEventStore();
    const originalStoreClose = vi.spyOn(originalStore, "close");
    const resolved = ResolvedRunSchema.parse({
      rootRunId: runId,
      runs: [{ runId, role: "root", events: [event] }],
    });
    const replay = await buildReplayRuntime(resolved, {
      run: RunConfigSchema.parse({}),
      store: StoreConfigSchema.parse({
        dialect: "postgres",
        connectionString: "env:ORIGINAL_STORE_URL",
      }),
      vault: VaultConfigSchema.parse({
        backend: "postgres",
        postgres: { url: "env:ORIGINAL_VAULT_URL" },
      }),
    });

    expect(replay.runtime.store).not.toBe(originalStore);
    expect(replay.runtime.store).toBeInstanceOf(PiiEventStore);
    expect(replay.runtime.ids.next()).toBe(runId);
    expect(replay.runtime.ids.next()).toBe(event.segmentId);
    const fallbackId = replay.runtime.ids.next();
    expect(Id.safeParse(fallbackId).success).toBe(true);
    expect(replay.report.diagnostics).toEqual(["replay_ids_exhausted"]);
    await expect(
      replay.runtime.sandboxBackend.exec(
        runId,
        ExecSpecSchema.parse({
          argv: ["echo"],
          timeoutMs: 1,
          limits: { memoryMb: 1, pids: 1, outputBytes: 1, cpuSeconds: 1 },
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "replay_external_access" });

    await replay.runtime.close();
    expect(originalStoreClose).not.toHaveBeenCalled();
    await originalStore.close();
  });

  it("handles a validated resolution with no root events deterministically", async () => {
    const replay = await buildReplayRuntime(
      ResolvedRunSchema.parse({ rootRunId: runId, runs: [] }),
      { run: RunConfigSchema.parse({}) },
    );

    expect(replay.runtime.clock.now()).toBe(0);
    expect(replay.report.diagnostics).toEqual([]);
    await replay.runtime.close();
  });
});
