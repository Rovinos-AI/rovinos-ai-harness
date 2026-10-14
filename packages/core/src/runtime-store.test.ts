// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeClock,
  Id,
  KeysConfigSchema,
  SecretRefSchema,
  type KeyProvider,
} from "@harness/schemas";
import { AesGcmContentCodec, SqliteEventStore, StoreUnavailableError } from "@harness/store";
import { SqliteVault } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConfiguredKeyRotation, openConfiguredVaultAdmin } from "./runtime-store.js";

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
const keyA = new Uint8Array(32).fill(51);
const keyB = new Uint8Array(32).fill(52);
const rotationKeys = KeysConfigSchema.parse({
  currentKeyId: "key-b",
  keys: [
    { id: "key-a", secret: "env:ROTATION_KEY_A" },
    { id: "key-b", secret: "env:ROTATION_KEY_B" },
  ],
});
const rotationSecretResolver = {
  resolve: (ref: string) =>
    Promise.resolve({
      reveal: () => Buffer.from(ref.endsWith("_A") ? keyA : keyB).toString("base64"),
    }),
};

function provider(currentKeyId: string): KeyProvider {
  return {
    currentKeyId: () => currentKeyId,
    getKey: (keyId) => {
      let key: Uint8Array | undefined;
      if (keyId === "key-a") {
        key = keyA;
      } else if (keyId === "key-b") {
        key = keyB;
      }
      return key === undefined
        ? Promise.reject(new Error("synthetic unavailable key"))
        : Promise.resolve(Uint8Array.from(key));
    },
  };
}

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

  describe("openConfiguredKeyRotation", () => {
    it("does not create absent vault or SQLite store databases", async () => {
      const directory = await temporaryDirectory();
      const rotation = await openConfiguredKeyRotation(
        { keys },
        { dataDir: directory, vault: true, store: true, secretResolver },
      );
      try {
        await expect(rotation.vault?.countRowsByKey()).resolves.toEqual([]);
        await expect(rotation.store?.countRowsByKey()).resolves.toEqual([]);
        await expect(
          rotation.vault?.reencryptBatch({ targetKeyId: keys.currentKeyId }),
        ).resolves.toEqual({ processed: 0 });
        await expect(
          rotation.store?.reencryptBatch({ targetKeyId: keys.currentKeyId }),
        ).resolves.toEqual({ processed: 0 });
      } finally {
        await rotation.close();
      }
      expect(existsSync(join(directory, "vault.db"))).toBe(false);
      expect(existsSync(join(directory, "harness.db"))).toBe(false);
    });

    it("opens and closes the configured Postgres adapter", async () => {
      const rotation = await openConfiguredKeyRotation(
        {
          keys,
          store: {
            dialect: "postgres",
            connectionString: SecretRefSchema.parse("env:HARNESS_STORE_URL"),
          },
        },
        {
          vault: false,
          store: true,
          secretResolver: {
            resolve: (ref) =>
              Promise.resolve({
                reveal: () =>
                  ref === "env:HARNESS_STORE_URL"
                    ? "postgresql://harness@127.0.0.1:5432/harness"
                    : Buffer.alloc(32, 41).toString("base64"),
              }),
          },
        },
      );
      expect(rotation.store).toBeDefined();
      await rotation.close();
    });

    it("closes opened adapters and disposes keys when store configuration cannot resolve", async () => {
      const directory = await temporaryDirectory();
      new SqliteVault(join(directory, "vault.db"), keyProvider).close();

      await expect(
        openConfiguredKeyRotation(
          {
            keys,
            store: {
              dialect: "postgres",
              connectionString: SecretRefSchema.parse("env:HARNESS_STORE_URL"),
            },
          },
          {
            dataDir: directory,
            vault: true,
            store: true,
            secretResolver: {
              resolve: (ref) =>
                ref === "env:HARNESS_STORE_URL"
                  ? Promise.reject(new StoreUnavailableError())
                  : secretResolver.resolve(),
            },
          },
        ),
      ).rejects.toMatchObject({ code: "store_unavailable" });
    });

    it("opens configured adapters and rotates both stores with the current key", async () => {
      const directory = await temporaryDirectory();
      const oldProvider = provider("key-a");
      const seedVault = new SqliteVault(join(directory, "vault.db"), oldProvider);
      const token = await seedVault.put(runId, "email", "alice@example.test");
      seedVault.close();
      const seedStore = new SqliteEventStore(
        join(directory, "harness.db"),
        new AesGcmContentCodec(oldProvider),
      );
      const traceId = "a".repeat(32);
      const spanId = "b".repeat(16);
      await seedStore.append(
        runId,
        [
          {
            runId,
            ts: 1,
            v: 1,
            traceId,
            spanId,
            segmentId: runId,
            type: "run_created",
            configHash: "c".repeat(64),
            policyVersion: "policy.v1",
            depth: 0,
          },
          {
            runId,
            ts: 2,
            v: 1,
            traceId,
            spanId,
            segmentId: runId,
            type: "model_request",
            requestId: runId,
            provider: "test",
            model: "test",
            messages: [{ role: "user", parts: [{ type: "text", text: "synthetic content" }] }],
          },
        ],
        0,
      );
      await seedStore.close();

      const rotation = await openConfiguredKeyRotation(
        { keys: rotationKeys },
        { dataDir: directory, vault: true, store: true, secretResolver: rotationSecretResolver },
      );
      try {
        expect(rotation.currentKeyId).toBe("key-b");
        for (const adapter of [rotation.vault, rotation.store]) {
          if (adapter === undefined) {
            throw new Error("Expected both configured rotation adapters");
          }
          let cursor: string | undefined;
          do {
            const batch = await adapter.reencryptBatch({
              targetKeyId: rotation.currentKeyId,
              ...(cursor === undefined ? {} : { afterCursor: cursor }),
            });
            cursor = batch.nextCursor;
          } while (cursor !== undefined);
        }
        await expect(rotation.vault?.countRowsByKey()).resolves.toEqual([
          { keyId: "key-b", count: 1 },
        ]);
        await expect(rotation.store?.countRowsByKey()).resolves.toEqual([
          { keyId: "key-b", count: 2 },
        ]);
      } finally {
        await rotation.close();
      }

      const currentProvider = provider("key-b");
      const verifyVault = new SqliteVault(join(directory, "vault.db"), currentProvider);
      const verifyStore = new SqliteEventStore(
        join(directory, "harness.db"),
        new AesGcmContentCodec(currentProvider),
      );
      try {
        await expect(verifyVault.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
          "alice@example.test",
        );
        const events: string[] = [];
        for await (const event of verifyStore.read(runId)) {
          if (event.type === "model_request") {
            const text = event.messages[0]?.parts[0];
            if (text?.type === "text") {
              events.push(text.text);
            }
          }
        }
        expect(events).toEqual(["synthetic content"]);
      } finally {
        verifyVault.close();
        await verifyStore.close();
      }
    });
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
