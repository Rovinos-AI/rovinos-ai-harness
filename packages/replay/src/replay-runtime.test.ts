// SPDX-License-Identifier: Apache-2.0
import { PiiEventStore } from "@rovinos/pii";
import {
  Code,
  Event as EventSchema,
  Id,
  type NewEvent,
  RunConfigSchema,
  StoreConfigSchema,
  VaultConfigSchema,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { ExecSpecSchema } from "@rovinos/sandbox";
import { InMemoryVault } from "@rovinos/vault";
import { describe, expect, it, vi } from "vitest";
import { resolveRun, ResolvedRunSchema } from "./resolve.js";
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
  it("isolates every original resource, sanitizes storage, and blocks sandbox execution", async () => {
    const originalStore = new InMemoryEventStore();
    const originalVault = new InMemoryVault();
    const rawCanary = "replay-storage-canary@example.test";
    await originalStore.append(
      runId,
      [
        {
          runId,
          ts: 100,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: event.segmentId,
          type: "run_created",
          configHash: "c".repeat(64),
          policyVersion: "test",
        },
      ],
      0,
    );
    await originalVault.put(runId, Code.parse("email"), rawCanary);
    const resolved = await resolveRun({ store: originalStore, runId });
    const originalStoreSpies = [
      vi.spyOn(originalStore, "append"),
      vi.spyOn(originalStore, "appendWithSnapshot"),
      vi.spyOn(originalStore, "appendWithUsage"),
      vi.spyOn(originalStore, "readUsageLedger"),
      vi.spyOn(originalStore, "claimRunExecution"),
      vi.spyOn(originalStore, "renewRunExecution"),
      vi.spyOn(originalStore, "releaseRunExecution"),
      vi.spyOn(originalStore, "latestSnapshot"),
      vi.spyOn(originalStore, "retainedSnapshots"),
      vi.spyOn(originalStore, "read"),
      vi.spyOn(originalStore, "watch"),
      vi.spyOn(originalStore, "watchRuns"),
      vi.spyOn(originalStore, "head"),
      vi.spyOn(originalStore, "deleteRun"),
      vi.spyOn(originalStore, "listRuns"),
      vi.spyOn(originalStore, "findRunsByTrace"),
      vi.spyOn(originalStore, "fetchOutbox"),
      vi.spyOn(originalStore, "ackOutbox"),
      vi.spyOn(originalStore, "claimApprovalNotification"),
      vi.spyOn(originalStore, "markApprovalNotificationSent"),
      vi.spyOn(originalStore, "releaseApprovalNotification"),
      vi.spyOn(originalStore, "consumeConfirmationState"),
      vi.spyOn(originalStore, "claimIdempotencyKey"),
      vi.spyOn(originalStore, "takeoverIdempotencyKey"),
      vi.spyOn(originalStore, "releaseIdempotencyKey"),
      vi.spyOn(originalStore, "close"),
    ];
    const originalVaultSpies = [
      vi.spyOn(originalVault, "put"),
      vi.spyOn(originalVault, "resolve"),
      vi.spyOn(originalVault, "listRawValues"),
      vi.spyOn(originalVault, "listRawValueEntries"),
      vi.spyOn(originalVault, "version"),
      vi.spyOn(originalVault, "markTerminal"),
      vi.spyOn(originalVault, "listTerminalRunsBefore"),
      vi.spyOn(originalVault, "purge"),
      vi.spyOn(originalVault, "stats"),
    ];
    const replayInnerAppend = vi.spyOn(InMemoryEventStore.prototype, "append");
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
    const created: NewEvent = {
      runId,
      ts: 100,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: event.segmentId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
    };
    const rawInput: NewEvent = {
      runId,
      ts: 101,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: event.segmentId,
      type: "run_input",
      input: { goal: rawCanary },
      inputKind: "initial",
    };
    await replay.runtime.store.append(runId, [created, rawInput], 0);
    const storedEvents = [];
    for await (const stored of replay.runtime.store.read(runId)) {
      storedEvents.push(stored);
    }
    expect(JSON.stringify(storedEvents)).not.toContain(rawCanary);
    expect(JSON.stringify(storedEvents)).toContain("<EMAIL_1>");
    expect(JSON.stringify(replayInnerAppend.mock.calls)).not.toContain(rawCanary);
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
    for (const spy of [...originalStoreSpies, ...originalVaultSpies]) {
      expect(spy).not.toHaveBeenCalled();
    }
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
