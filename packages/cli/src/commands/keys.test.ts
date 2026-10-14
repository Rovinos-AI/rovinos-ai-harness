// SPDX-License-Identifier: Apache-2.0
import { KeyGenerateResultSchema, KeyRetireResultSchema, parseJson } from "@harness/schemas";
import { HarnessConfigSchema } from "@harness/config";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { createOutput } from "../output.js";
import { main } from "../main.js";
import { keysCommand } from "./keys.js";

function createContext(overrides: Partial<CliContext> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
    ...overrides,
  };
  return { context, stdout, stderr };
}

describe("harness keys generate", () => {
  it("prints a fresh 32-byte base64 key and storage guidance", async () => {
    const { context, stdout, stderr } = createContext();

    const exitCode = await main(["keys", "generate"], context, [keysCommand]);
    const [key = ""] = stdout[0]?.split("\n") ?? [];

    expect(exitCode).toBe(ExitCode.ok);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(Buffer.from(key, "base64").toString("base64")).toBe(key);
    expect(stdout.join("")).toContain("environment variable or a secret store");
    expect(stderr).toEqual([]);
  });

  it("emits the generated key as one validated JSON document when requested", async () => {
    const { context, stdout, stderr } = createContext();

    const exitCode = await main(["--json", "keys", "generate"], context, [keysCommand]);
    const result = parseJson(KeyGenerateResultSchema, stdout[0] ?? "");

    expect(exitCode).toBe(ExitCode.ok);
    expect(Buffer.from(result.key, "base64")).toHaveLength(32);
    expect(result.instructions).toContain("secret store");
    expect(stderr).toEqual([]);
  });

  it("mentions secret storage in command help", async () => {
    const { context, stdout } = createContext();

    const exitCode = await main(["keys", "generate", "--help"], context, [keysCommand]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("environment variable or secret store");
  });

  it("rotates the selected stores in resumable batches and logs only counts", async () => {
    const calls: string[] = [];
    const logged: { event: string; fields: unknown }[] = [];
    const makeAdapter = (name: string) => ({
      async reencryptBatch(input: {
        readonly targetKeyId: string;
        readonly limit?: number | undefined;
        readonly afterCursor?: string | undefined;
      }): Promise<{ processed: number; nextCursor?: string | undefined }> {
        calls.push(`${name}:${input.afterCursor ?? "start"}`);
        return input.afterCursor === undefined
          ? { processed: 2, nextCursor: `${name}-cursor` }
          : { processed: 1 };
      },
      countRowsByKey: () => Promise.resolve([]),
    });
    const { context, stdout, stderr } = createContext({
      openKeyRotation: async (_config, selection) => ({
        currentKeyId: "key-b",
        ...(selection.vault ? { vault: { ...makeAdapter("vault"), close: () => undefined } } : {}),
        ...(selection.store
          ? { store: { ...makeAdapter("store"), close: async () => undefined } }
          : {}),
        close: async () => undefined,
      }),
      keyRotationLogger: {
        info: (event, fields) => logged.push({ event, fields }),
      },
    });

    const exitCode = await main(
      ["keys", "rotate", "--to", "key-b"],
      context,
      [keysCommand],
    );

    expect(exitCode).toBe(ExitCode.ok);
    expect(calls).toEqual([
      "vault:start",
      "vault:vault-cursor",
      "store:start",
      "store:store-cursor",
    ]);
    expect(logged).toEqual([
      { event: "keys_rotated", fields: { vault: 3, store: 3 } },
    ]);
    expect(stdout.join("")).toContain("vault=3 store=3");
    expect(stderr).toEqual([]);
  });

  it("refuses retirement while either store still references the key", async () => {
    const { context, stdout, stderr } = createContext({
      openKeyRotation: async () => ({
        currentKeyId: "key-b",
        vault: {
          reencryptBatch: () => Promise.resolve({ processed: 0 }),
          countRowsByKey: () => Promise.resolve([{ keyId: "key-a", count: 1 }]),
          close: () => undefined,
        },
        store: {
          reencryptBatch: () => Promise.resolve({ processed: 0 }),
          countRowsByKey: () => Promise.resolve([]),
          close: async () => undefined,
        },
        close: async () => undefined,
      }),
    });

    const exitCode = await main(["keys", "retire", "key-a"], context, [keysCommand]);

    expect(exitCode).toBe(ExitCode.failure);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["key_in_use\n"]);
  });

  it("allows retirement only after both stores report zero references", async () => {
    const { context, stdout, stderr } = createContext({
      openKeyRotation: async () => ({
        currentKeyId: "key-b",
        vault: {
          reencryptBatch: () => Promise.resolve({ processed: 0 }),
          countRowsByKey: () => Promise.resolve([]),
          close: () => undefined,
        },
        store: {
          reencryptBatch: () => Promise.resolve({ processed: 0 }),
          countRowsByKey: () => Promise.resolve([]),
          close: async () => undefined,
        },
        close: async () => undefined,
      }),
    });

    const exitCode = await main(["--json", "keys", "retire", "key-a"], context, [keysCommand]);

    expect(exitCode).toBe(ExitCode.ok);
    expect(parseJson(KeyRetireResultSchema, stdout[0] ?? "")).toEqual({
      keyId: "key-a",
      status: "safe_to_remove",
    });
    expect(stderr).toEqual([]);
  });
});
