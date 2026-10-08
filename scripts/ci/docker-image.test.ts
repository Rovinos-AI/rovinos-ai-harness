// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
  "utf8",
);

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it("pins multi-platform base indexes and installs only build-stage tools", () => {
  expect(dockerfile).toContain(
    "FROM ghcr.io/jdx/mise:2026.10.4-debian@sha256:2fb7fa9a4120333531a8a70296d4ea152ffd3e7658dcf29ac75774a7d78dec24 AS build",
  );
  expect(dockerfile).toContain(
    "FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime",
  );
  expect(dockerfile).toContain("RUN mise install node npm:corepack");
  expect(dockerfile).toContain("ENV MISE_AUTO_INSTALL=false");
  expect(dockerfile).toContain("RUN mise exec -- corepack enable");
  expect(dockerfile).not.toMatch(/^RUN mise install\s*&&/mu);
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
