// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it("removes the image even if Compose teardown fails", async () => {
  const beforeAll = vi.fn<(callback: () => void) => void>();
  const afterAll = vi.fn<(callback: () => void) => void>();
  const test = vi.fn<(name: string, callback: () => void) => void>();
  const composeError = new Error("compose_unavailable");
  const execFileSync = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "compose") {
      throw composeError;
    }
    return "";
  });
  vi.doMock("node:child_process", () => ({ execFileSync }));
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
  build?.();
  expect(() => startCompose?.()).toThrow(composeError);
  expect(() => cleanup?.()).toThrow(composeError);

  expect(execFileSync.mock.calls.at(-1)?.[1]).toEqual([
    "image",
    "rm",
    "--force",
    `harness:integration-${String(process.pid)}`,
  ]);
});
