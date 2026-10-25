// SPDX-License-Identifier: Apache-2.0
import { FakeClock, Id } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import { InMemoryVault } from "./memory.js";
import { purgeExpired, VaultPurger } from "./purger.js";
import type { VaultAdmin } from "./types.js";

const DAY_MS = 86_400_000;
const context = { boundary: "ui" } as const;

function runId(index: number): Id {
  return Id.parse(String(index).padStart(26, "0"));
}

describe("VaultPurger", () => {
  it("purges only runs strictly older than the grace-period boundary", async () => {
    const now = 10 * DAY_MS;
    const cutoff = now - 7 * DAY_MS;
    const clock = new FakeClock(now);
    const vault = new InMemoryVault();
    const expiredId = runId(1);
    const boundaryId = runId(2);
    const recentId = runId(3);
    const activeId = runId(4);
    const [expiredToken, boundaryToken, recentToken, activeToken] = await Promise.all([
      vault.put(expiredId, "email", "alice@example.test"),
      vault.put(boundaryId, "email", "alice@example.test"),
      vault.put(recentId, "email", "alice@example.test"),
      vault.put(activeId, "email", "alice@example.test"),
    ]);
    await vault.markTerminal(expiredId, cutoff - 1);
    await vault.markTerminal(boundaryId, cutoff);
    await vault.markTerminal(recentId, cutoff + 1);

    await expect(purgeExpired({ vault, clock, purgeAfterDays: 7 })).resolves.toEqual({
      examined: 1,
      purged: 1,
      entriesPurged: 1,
    });
    await expect(vault.resolve(expiredId, expiredToken, context)).resolves.toBeUndefined();
    await expect(vault.resolve(boundaryId, boundaryToken, context)).resolves.toBe(
      "alice@example.test",
    );
    await expect(vault.resolve(recentId, recentToken, context)).resolves.toBe("alice@example.test");
    await expect(vault.resolve(activeId, activeToken, context)).resolves.toBe("alice@example.test");
  });

  it("purges terminal runs in batches, reports counts, and is idempotent", async () => {
    const clock = new FakeClock(10 * DAY_MS);
    const vault = new InMemoryVault();
    for (let index = 1; index <= 101; index += 1) {
      const id = runId(index);
      await vault.put(id, "email", `person-${String(index)}@example.test`);
      await vault.markTerminal(id, DAY_MS);
    }

    const purger = new VaultPurger({ vault, clock, purgeAfterDays: 7 });
    await expect(purger.purgeExpired()).resolves.toEqual({
      examined: 101,
      purged: 101,
      entriesPurged: 101,
    });
    await expect(purger.purgeExpired()).resolves.toEqual({
      examined: 0,
      purged: 0,
      entriesPurged: 0,
    });
  });

  it("stops when a purge batch contains only terminal runs already purged in this call", async () => {
    const id = runId(1);
    const purge = vi.fn(() => Promise.resolve(1));
    const vault: VaultAdmin = {
      markTerminal: () => Promise.resolve(),
      listTerminalRunsBefore: () => Promise.resolve([id]),
      purge,
      stats: () => Promise.resolve({ entries: 1 }),
    };

    await expect(
      purgeExpired({ vault, clock: new FakeClock(10 * DAY_MS), purgeAfterDays: 7 }),
    ).rejects.toMatchObject({ code: "vault_purge_stalled" });
    expect(purge).toHaveBeenCalledOnce();
  });

  it("validates the configured grace period", () => {
    expect(
      () =>
        new VaultPurger({
          vault: new InMemoryVault(),
          clock: new FakeClock(0),
          purgeAfterDays: 0,
        }),
    ).toThrow();
  });
});
