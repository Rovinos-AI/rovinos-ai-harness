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
    "FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime",
  );
  expect(dockerfile).toContain("RUN mise install node npm:corepack");
  expect(dockerfile).toContain("ENV MISE_AUTO_INSTALL=false");
  expect(dockerfile).toContain("RUN mise exec -- corepack enable");
  expect(dockerfile).not.toMatch(/^RUN mise install\s*&&/mu);
});

it("copies the packed CLI asset tree into the runtime image", () => {
  expect(dockerfile).toContain("cp -a packages/cli/dist /out/");
  expect(dockerfile).not.toContain("/out/migrations");
  expect(dockerfile).not.toContain("/out/web");
});

it("removes the image even if Compose teardown fails", async () => {
  const beforeAll = vi.fn<(callback: () => Promise<void>) => void>();
  const afterAll = vi.fn<(callback: () => Promise<void>) => void>();
  const test = vi.fn<(name: string, callback: () => Promise<void>) => void>();
  const composeError = new Error("compose_unavailable");
  const runCommand = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "logs") {
      return Promise.resolve({ stdout: "http://127.0.0.1:12345/mcp", stderr: "" });
    }
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
  const startBundledServer = test.mock.calls[2]?.[1];
  const startCompose = test.mock.calls[3]?.[1];
  const cleanup = afterAll.mock.calls[0]?.[0];
  expect(build).toBeDefined();
  expect(startBundledServer).toBeDefined();
  expect(startCompose).toBeDefined();
  expect(cleanup).toBeDefined();
  await build?.();
  await startBundledServer?.();
  await expect(startCompose?.()).rejects.toBe(composeError);
  await expect(cleanup?.()).rejects.toBe(composeError);

  expect(runCommand.mock.calls.at(-1)?.[1]).toEqual([
    "image",
    "rm",
    "--force",
    `harness:integration-${String(process.pid)}`,
  ]);
});

it("removes the image when the bundled server exits", async () => {
  const beforeAll = vi.fn<(callback: () => Promise<void>) => void>();
  const afterAll = vi.fn<(callback: () => Promise<void>) => void>();
  const test = vi.fn<(name: string, callback: () => Promise<void>) => void>();
  const runCommand = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "inspect") {
      return Promise.resolve({
        stdout: args[2] === "{{.State.Status}}" ? "exited" : "1",
        stderr: "",
      });
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
  const startBundledServer = test.mock.calls[2]?.[1];
  const cleanup = afterAll.mock.calls[0]?.[0];
  expect(build).toBeDefined();
  expect(startBundledServer).toBeDefined();
  expect(cleanup).toBeDefined();
  await build?.();
  await expect(startBundledServer?.()).rejects.toThrow("bundled_server_exited:exited:1:");
  await cleanup?.();

  expect(runCommand.mock.calls.at(-1)?.[1]).toEqual([
    "image",
    "rm",
    "--force",
    `harness:integration-${String(process.pid)}`,
  ]);
});
