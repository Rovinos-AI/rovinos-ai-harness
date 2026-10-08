// SPDX-License-Identifier: Apache-2.0
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it("removes the image even if Compose teardown fails", async () => {
  const beforeAll = vi.fn<(callback: () => Promise<void>) => void>();
  const afterAll = vi.fn<(callback: () => Promise<void>) => void>();
  const test = vi.fn<(name: string, callback: () => Promise<void>) => void>();
  const composeError = new Error("compose_unavailable");
  const runCommand = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "compose") {
      return Promise.reject(composeError);
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: runCommand });
  vi.doMock("node:child_process", () => ({ execFile }));
  vi.doMock("vitest", () => ({
    beforeAll,
    afterAll,
    describe: (_name: string, callback: () => void): void => {
      callback();
    },
    expect,
    it: test,
  }));

  await import("./docker-image.int.test.js");
  const build = beforeAll.mock.calls[0]?.[0];
  const startCompose = test.mock.calls[1]?.[1];
  const cleanup = afterAll.mock.calls[0]?.[0];
  expect(build).toBeDefined();
  expect(startCompose).toBeDefined();
  expect(cleanup).toBeDefined();
  await build?.();
  await expect(startCompose?.()).rejects.toBe(composeError);
  await expect(cleanup?.()).rejects.toBe(composeError);

  expect(runCommand.mock.calls.at(-1)?.[1]).toEqual([
    "image",
    "rm",
    "--force",
    `harness:integration-${String(process.pid)}`,
  ]);
});
