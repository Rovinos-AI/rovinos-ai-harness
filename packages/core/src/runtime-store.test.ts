// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, Id, KeysConfigSchema } from "@harness/schemas";
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

let directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-vault-maintenance-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

describe("openConfiguredVaultAdmin", () => {
  it("opens the configured vault with injected time and closes its maintenance handle", async () => {
    const directory = await temporaryDirectory();
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
    await expect(admin.stats(runId)).resolves.toEqual({ entries: 0 });
    await expect(admin.purge(runId)).resolves.toBe(0);
    await expect(admin.listTerminalRunsBefore({ terminalBefore: 51, limit: 100 })).resolves.toEqual(
      [],
    );
    admin.close();
  });

  it("disposes keys when the vault database directory cannot be created", async () => {
    const parent = await temporaryDirectory();
    const invalidDirectory = join(parent, "not-a-directory");
    await writeFile(invalidDirectory, "synthetic");

    await expect(
      openConfiguredVaultAdmin({ keys }, { dataDir: invalidDirectory, secretResolver }),
    ).rejects.toBeDefined();
  });
});
