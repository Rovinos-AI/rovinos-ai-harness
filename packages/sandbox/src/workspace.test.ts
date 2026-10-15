// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Id } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerRequestHandler } from "../runner/src/server.js";
import type { Clock, ExecResult } from "./types.js";
import {
  activateRunWorkspace,
  clearRunScratch,
  ensureRunWorkspace,
  FsWorkspace,
  lockRunWorkspace,
  resolveWorkspacePath,
  SandboxWorkspacePathError,
  WorkspaceQuotaExceededError,
} from "./workspace.js";
import type { RunnerServerOptions } from "../runner/src/server.js";

const runA = Id.parse("00000000000000000000000001");
const runB = Id.parse("00000000000000000000000002");
const token = "synthetic-runner-token-for-workspace-tests";
const result: ExecResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 0,
};

class FakeClock implements Clock {
  #time = 0;
  readonly #timers: { readonly at: number; readonly callback: () => void; active: boolean }[] = [];

  now(): number {
    return this.#time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { at: this.#time + delayMs, callback, active: true };
    this.#timers.push(timer);
    return () => {
      timer.active = false;
    };
  }

  advanceBy(milliseconds: number): void {
    this.#time += milliseconds;
    for (const timer of this.#timers) {
      if (timer.active && timer.at <= this.#time) {
        timer.active = false;
        timer.callback();
      }
    }
  }
}

class TestResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  status = 0;
  body = "";

  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  end(body?: string): void {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.body = "";
  }
}

function request(path: string, body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: path,
    headers: { host: "runner.test", authorization: ["Bearer", token].join(" ") },
  });
}

async function call(
  handler: ReturnType<typeof createRunnerRequestHandler>,
  path: string,
  body: unknown,
): Promise<TestResponse> {
  const response = new TestResponse();
  await handler(request(path, body), response);
  return response;
}

function runnerOptions(root: string, clock: Clock): RunnerServerOptions {
  return {
    token,
    allowedHosts: ["runner.test"],
    workspaceRoot: root,
    temporaryRoot: join(root, "tmp"),
    clock,
    execute: () => Promise.resolve(result),
  };
}

let root: string | undefined;

afterEach(async () => {
  const temporaryRoot = root;
  root = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

describe("per-run filesystem workspace", () => {
  it("creates isolated project and harness directories with group access", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-workspace-layout-"));
    const project = await ensureRunWorkspace(root, runA);

    expect(project).toBe(join(root, runA, "project"));
    expect((await stat(join(project, "..", ".harness", "offload"))).isDirectory()).toBe(true);
    expect((await stat(project)).mode & 0o770).toBe(0o770);
  });

  // threat: T-12
  it("rejects traversal, absolute, NUL, long names, symlinks, and fuzzed escape paths", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-workspace-paths-"));
    const project = await ensureRunWorkspace(root, runA);
    const outside = await mkdtemp(join(tmpdir(), "sandbox-workspace-outside-"));
    await mkdir(join(project, "inside"));
    await writeFile(join(project, "inside", "file"), "ok");
    await symlink(outside, join(project, "outside-link"));
    await symlink(join(project, "inside"), join(project, "inside-link"));

    for (const path of [
      "../outside",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "file\0name",
      `${"a".repeat(256)}/file`,
      "a".repeat(4097),
      "outside-link/file",
      "inside-link/file",
    ]) {
      await expect(resolveWorkspacePath(project, path)).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
    }

    for (let index = 0; index < 128; index += 1) {
      const candidate = `${"safe/".repeat(index % 7)}${"../".repeat((index % 5) + 1)}escape`;
      await expect(resolveWorkspacePath(project, candidate)).rejects.toBeInstanceOf(
        SandboxWorkspacePathError,
      );
    }
    await expect(resolveWorkspacePath(project, "inside/file")).resolves.toBe(
      join(project, "inside", "file"),
    );
    await rm(outside, { recursive: true, force: true });
  });

  // threat: T-09
  it("enforces the file and aggregate quota, recounts external changes, and serves ranges", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-workspace-quota-"));
    const workspace = new FsWorkspace({
      workspaceRoot: root,
      runId: runA,
      maxFileBytes: 5,
      quotaBytes: 8,
      recountIntervalMs: 0,
    });
    const first = new TextEncoder().encode("12345");
    await workspace.write(".harness/offload/first.json", first);
    await expect(
      workspace.write(".harness/offload/too-large.json", new TextEncoder().encode("123456")),
    ).rejects.toBeInstanceOf(WorkspaceQuotaExceededError);
    await expect(
      workspace.write(".harness/offload/second.json", new TextEncoder().encode("1234")),
    ).rejects.toMatchObject({ code: "workspace_quota_exceeded" });
    await expect(
      workspace.read(".harness/offload/first.json", { offset: 2, length: 2 }),
    ).resolves.toEqual(Buffer.from("34"));
    await expect(workspace.read(".harness/offload/missing.json")).rejects.toMatchObject({
      code: "workspace_file_not_found",
    });
    await expect(workspace.write(".harness/project/other", new Uint8Array())).rejects.toBeDefined();
    await expect(
      workspace.write(".harness/offload/first.json", new TextEncoder().encode("123")),
    ).resolves.toBeUndefined();
    await writeFile(join(root, runA, "project", "external"), "external-file");
    await expect(
      workspace.write(".harness/offload/second.json", new TextEncoder().encode("1")),
    ).rejects.toMatchObject({ code: "workspace_quota_exceeded" });
  });

  it("refuses symbolic links while opening workspace files", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-workspace-symlink-"));
    const outside = join(root, "outside");
    await writeFile(outside, "synthetic-private-content");
    const workspace = new FsWorkspace({ workspaceRoot: root, runId: runA });
    await ensureRunWorkspace(root, runA);
    await symlink(outside, join(root, runA, ".harness", "offload", "linked"));

    await expect(workspace.read(".harness/offload/linked")).rejects.toMatchObject({
      code: "workspace_path_invalid",
    });
    await expect(
      workspace.write(".harness/offload/linked", new TextEncoder().encode("overwrite")),
    ).rejects.toMatchObject({ code: "workspace_path_invalid" });
    expect(await readFile(outside, "utf8")).toBe("synthetic-private-content");
  });

  // threat: T-13
  it("rejects a second run until the owner releases or expires the lease and renews on exec", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-runner-lease-"));
    await mkdir(join(root, "tmp"));
    await writeFile(join(root, "tmp", "leftover"), "previous-run");
    const clock = new FakeClock();
    const handler = createRunnerRequestHandler(runnerOptions(root, clock));

    expect((await call(handler, "/lease", { runId: runA, ttlMs: 100 })).status).toBe(200);
    await expect(readdir(join(root, "tmp"))).resolves.toEqual([]);
    expect((await call(handler, "/lease", { runId: runB, ttlMs: 100 })).status).toBe(409);
    clock.advanceBy(60);
    expect(
      (
        await call(handler, "/exec", {
          runId: runA,
          spec: {
            argv: ["/bin/true"],
            timeoutMs: 100,
            limits: { memoryMb: 32, pids: 2, outputBytes: 0, cpuSeconds: 1 },
          },
        })
      ).status,
    ).toBe(200);
    expect((await call(handler, "/lease", { runId: runB, ttlMs: 100 })).status).toBe(409);
    clock.advanceBy(60);
    expect((await call(handler, "/lease", { runId: runB, ttlMs: 100 })).status).toBe(409);
    expect((await call(handler, "/release", { runId: runA })).status).toBe(200);
    expect((await call(handler, "/lease", { runId: runB, ttlMs: 100 })).status).toBe(200);
    clock.advanceBy(101);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await call(handler, "/lease", { runId: runA, ttlMs: 100 })).status).toBe(200);
  });

  // threat: T-14
  it("locks old run directories and wipes run scratch before another run starts", async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-run-isolation-"));
    const firstProject = await activateRunWorkspace(root, runA);
    await writeFile(join(firstProject, "private.txt"), "first-run-only");
    await writeFile(join(root, runA, ".harness", "tmp", "scratch"), "scratch");
    await lockRunWorkspace(root, runA);
    await clearRunScratch(root, runA);
    await expect(readdir(join(root, runA, ".harness", "tmp"))).resolves.toEqual([]);

    const secondProject = await activateRunWorkspace(root, runB);
    await clearRunScratch(root, runB);

    expect(secondProject).toBe(join(root, runB, "project"));
    expect((await stat(join(root, runA))).mode & 0o777).toBe(0o700);
    await expect(readFile(join(secondProject, "private.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, runA, "project", "private.txt"), "utf8")).toBe(
      "first-run-only",
    );
  });
});
