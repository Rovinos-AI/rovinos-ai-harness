// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { VaultAdmin, VaultReader, VaultResolver, VaultWriter } from "./types.js";

type Vault = VaultWriter & VaultResolver & VaultReader & VaultAdmin;

interface VaultHarness {
  vault: Vault;
  cleanup(): Promise<void>;
}

type VaultFactory = () => Promise<VaultHarness>;

const runId = "A".repeat(26);
const anotherRunId = "B".repeat(26);

/** Register the shared behavioral contract against a vault implementation factory. */
export function runVaultConformance(name: string, createVault: VaultFactory): void {
  describe(name, () => {
    it("reuses normalized values and preserves the trimmed original", async () => {
      const harness = await createVault();
      try {
        const first = await harness.vault.put(runId, "email", "  Alice@Example.test ");
        const second = await harness.vault.put(runId, "email", "alice@example.test");

        expect(first).toBe("<EMAIL_1>");
        expect(second).toBe(first);
        await expect(harness.vault.resolve(runId, first)).resolves.toBe("Alice@Example.test");
      } finally {
        await harness.cleanup();
      }
    });

    it("numbers independently by run and entity type", async () => {
      const harness = await createVault();
      try {
        await expect(harness.vault.put(runId, "email", "alice@example.test")).resolves.toBe(
          "<EMAIL_1>",
        );
        await expect(harness.vault.put(runId, "email", "bob@example.test")).resolves.toBe(
          "<EMAIL_2>",
        );
        await expect(harness.vault.put(runId, "phone", "5550100000")).resolves.toBe("<PHONE_1>");
        await expect(harness.vault.put(anotherRunId, "email", "alice@example.test")).resolves.toBe(
          "<EMAIL_1>",
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("shares numbering for entity types that produce the same token prefix", async () => {
      const harness = await createVault();
      try {
        await expect(harness.vault.put(runId, "a-b", "first")).resolves.toBe("<A_B_1>");
        await expect(harness.vault.put(runId, "a.b", "second")).resolves.toBe("<A_B_2>");
      } finally {
        await harness.cleanup();
      }
    });

    it("returns undefined for unknown tokens and after idempotent purge", async () => {
      const harness = await createVault();
      try {
        const token = await harness.vault.put(runId, "email", "alice@example.test");
        await expect(harness.vault.resolve(runId, "<EMAIL_2>")).resolves.toBeUndefined();
        await expect(harness.vault.purge(runId)).resolves.toBe(1);
        await expect(harness.vault.purge(runId)).resolves.toBe(0);
        await expect(harness.vault.resolve(runId, token)).resolves.toBeUndefined();
        await expect(harness.vault.stats(runId)).resolves.toEqual({ entries: 0 });
        await expect(harness.vault.put(runId, "email", "alice@example.test")).resolves.toBe(
          "<EMAIL_2>",
        );
      } finally {
        await harness.cleanup();
      }
    });
  });
}
