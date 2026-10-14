// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, Id, KeysConfigSchema } from "@harness/schemas";
import { SqliteVault } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConfiguredVaultAdmin } from "./runtime-store.js";

const runId = Id.parse("A".repeat(26));
const keys = KeysConfigSchema.parse({
  currentKeyId: "maintenance-test",
  keys: [{ id: "maintenance-test", secret: "env:HARNESS_VAULT_MAINTENANCE_KEY" }],
});
const secretResolver = {
  resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 41).toString("base64") }),
};
const keyProvider = {
  currentKeyId: () => "maintenance-test",
  getKey: () => Promise.resolve(new Uint8Array(32).fill(41)),
};

let directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-vault-maintenance-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

describe("openConfiguredVaultAdmin", () => {
  it("opens the configured vault with injected time and closes its maintenance handle", async () => {
    const directory = await temporaryDirectory();
    const seed = new SqliteVault(join(directory, "vault.db"), keyProvider, () => 100);
    await seed.put(runId, "email", "alice@example.test");
    await seed.markTerminal(runId, 50);
    seed.close();
    const resolve = vi.fn(secretResolver.resolve);
    const admin = await openConfiguredVaultAdmin(
      { keys },
      { dataDir: directory, clock: new FakeClock(100), secretResolver: { resolve } },
    );

    expect(resolve).toHaveBeenCalledWith("env:HARNESS_VAULT_MAINTENANCE_KEY");
    await admin.markTerminal(runId, 50);
    await expect(admin.listTerminalRunsBefore({ terminalBefore: 51, limit: 100 })).resolves.toEqual(
      [runId],
    );
    await expect(admin.stats(runId)).resolves.toEqual({ entries: 1 });
    await expect(admin.purge(runId)).resolves.toBe(1);
    await expect(admin.listTerminalRunsBefore({ terminalBefore: 51, limit: 100 })).resolves.toEqual(
      [],
    );
    admin.close();
  });

  it("does not create a database or key when no vault exists", async () => {
    const directory = await temporaryDirectory();
    const admin = await openConfiguredVaultAdmin({}, { dataDir: directory });

    await expect(admin.listTerminalRunsBefore({ terminalBefore: 1, limit: 100 })).resolves.toEqual(
      [],
    );
    expect(existsSync(join(directory, "vault.db"))).toBe(false);
    admin.close();
  });

  it("opens the vault from its separate configured data directory", async () => {
    const eventDirectory = await temporaryDirectory();
    const vaultDirectory = await temporaryDirectory();
    const seed = new SqliteVault(join(vaultDirectory, "vault.db"), keyProvider, () => 100);
    await seed.put(runId, "email", "alice@example.test");
    seed.close();
    vi.stubEnv("HARNESS_VAULT_DATA_DIR", vaultDirectory);

    const admin = await openConfiguredVaultAdmin(
      { keys },
      { dataDir: eventDirectory, secretResolver },
    );
    await expect(admin.stats(runId)).resolves.toEqual({ entries: 1 });
    expect(existsSync(join(eventDirectory, "vault.db"))).toBe(false);
    admin.close();
  });

  it("disposes keys when an existing vault database cannot be opened", async () => {
    const parent = await temporaryDirectory();
    await writeFile(join(parent, "vault.db"), "synthetic");

    await expect(
      openConfiguredVaultAdmin({ keys }, { dataDir: parent, secretResolver }),
    ).rejects.toMatchObject({ code: "vault_unavailable" });
  });
});
