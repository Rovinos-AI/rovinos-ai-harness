// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { Code, Id, SequentialIdGenerator } from "@harness/schemas";
import { ActiveRuns, SentinelGate, TripQueue, VaultRunView } from "@harness/telemetry";
import { describe, expect, it, vi } from "vitest";

describe("sentinel trip canary", () => {
  it("keeps a matched raw value and token out of the emitted metadata-only alert", async () => {
    const canary = `trip-${randomUUID()}@example.test`;
    const token = `<EMAIL_${randomUUID().replaceAll("-", "")}>`;
    const ids = new SequentialIdGenerator();
    const runId = Id.parse(ids.next());
    const emit = vi.fn();
    const tripQueue = new TripQueue({ emit, enabled: () => true });
    const values = new VaultRunView({
      version: () => Promise.resolve(1),
      listRawValueEntries: () =>
        Promise.resolve([{ entityType: Code.parse("email"), rawValue: canary }]),
    });
    const gate = new SentinelGate(values, new ActiveRuns(), { tripQueue });

    await expect(gate.check({ runId, text: `payload ${canary} ${token}` })).resolves.toEqual({
      ok: false,
      reason: "hit",
    });

    expect(emit).toHaveBeenCalledOnce();
    const serializedAlert = JSON.stringify(emit.mock.calls);
    expect(serializedAlert).not.toContain(canary);
    expect(serializedAlert).not.toContain(token);
    expect(serializedAlert).toContain(runId);
    expect(serializedAlert).toContain('"harness.sentinel.trip.count":1');
    expect(tripQueue.drainForRun(runId)).toEqual([
      { runId, entities: [{ type: "email", count: 1 }] },
    ]);
  });
});
