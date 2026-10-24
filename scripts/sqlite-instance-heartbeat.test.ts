// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { expect, it } from "vitest";
import { Id } from "@harness/schemas";
import { openSqliteInstanceHeartbeat } from "@harness/store-sqlite";

const instanceId = Id.parse("00000000000000000000000001");
const lockHolderSource = `
  const Database = require("better-sqlite3");
  const database = new Database(process.argv[1]);
  database.pragma("busy_timeout = 0");
  database.exec("BEGIN EXCLUSIVE");
  process.stdout.write("locked\\n");
  setInterval(() => {}, 1000);
`;

function waitForLock(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error("heartbeat_lock_timeout"));
    }, 5_000);
    let output = "";

    function finish(error?: Error): void {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    }

    function onData(chunk: Buffer | string): void {
      output += chunk.toString();
      if (output.includes("locked\n")) {
        finish();
      }
    }

    function onError(error: Error): void {
      finish(error);
    }

    function onExit(): void {
      finish(new Error("heartbeat_lock_holder_exited"));
    }

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

it("rejects a live SQLite owner and reclaims ownership after it is killed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-instance-lock-"));
  const databasePath = join(directory, "harness.db");
  const lockPath = `${databasePath}.instance-lock`;
  const holder = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", lockHolderSource, lockPath],
    {
      cwd: resolvePath("packages/store-sqlite"),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForLock(holder);
    await expect(
      openSqliteInstanceHeartbeat({ databasePath, instanceId, now: () => Date.now() }),
    ).resolves.toBeUndefined();

    const holderClosed = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      holder.once("close", (code, signal) => {
        resolve([code, signal]);
      });
    });
    holder.kill("SIGKILL");
    const [, signal] = await holderClosed;
    expect(signal).toBe("SIGKILL");

    const recovered = await openSqliteInstanceHeartbeat({
      databasePath,
      instanceId,
      now: () => Date.now(),
    });
    expect(recovered).toBeDefined();
    await recovered?.close();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const holderClosed = new Promise<void>((resolve) => {
        holder.once("close", () => {
          resolve();
        });
      });
      holder.kill("SIGKILL");
      await holderClosed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
