// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Code, Id, JsonValue } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  FsEditInputSchema,
  FsListInputSchema,
  FsReadInputSchema,
  FsSearchInputSchema,
  FsToolResultSchema,
  FsTools,
  FsWriteInputSchema,
  InProcessBackend,
  RemoteSandboxBackend,
  WorkspaceFileError,
  WorkspaceFileSystem,
  ensureRunWorkspace,
} from "./index.js";
import type { FsOperation } from "./fs-tools.js";
import { createRunnerRequestHandler } from "../runner/src/server.js";
import type { RunnerResponse, RunnerRequest } from "../runner/src/request-handler.js";

const runId = Id.parse("00000000000000000000000001");
const runnerToken = "synthetic-runner-token-for-filesystem-tests";
const roots: string[] = [];

class MemoryResponse extends EventEmitter implements RunnerResponse {
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

async function workspaceRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-tools-")));
  roots.push(root);
  return root;
}

async function remoteBackend(root: string): Promise<{
  readonly backend: RemoteSandboxBackend;
  readonly close: () => Promise<void>;
}> {
  const handler = createRunnerRequestHandler({
    token: runnerToken,
    allowedHosts: ["sandbox-runner:8080"],
    workspaceRoot: root,
    execute: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 0,
      }),
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const request: RunnerRequest = Object.assign(Readable.from([Buffer.from(body)]), {
      method: init?.method ?? "POST",
      url: url.pathname,
      headers: {
        host: url.host,
        authorization: headers.get("authorization") ?? undefined,
      },
    });
    const response = new MemoryResponse();
    await handler(request, response);
    return new Response(response.body, { status: response.status });
  };
  const backend = new RemoteSandboxBackend({
    url: "http://sandbox-runner:8080",
    token: runnerToken,
    fetcher,
  });
  await backend.acquireLease(runId);
  return {
    backend,
    close: async () => {
      await backend.releaseLease(runId);
    },
  };
}

async function makeBackend(
  kind: "in-process" | "remote",
  root: string,
): Promise<{ readonly backend: InProcessBackend | RemoteSandboxBackend; readonly close: () => Promise<void> }> {
  if (kind === "remote") {
    return remoteBackend(root);
  }
  return {
    backend: new InProcessBackend({
      workspaceRoot: root,
      logger: { log: () => undefined },
    }),
    close: () => Promise.resolve(),
  };
}

function toolCall(
  tool: FsTools,
  toolId: string,
  args: unknown,
): ReturnType<FsTools["execute"]> {
  return tool.execute(
    {
      callId: runId,
      toolId: Code.parse(toolId),
      args: JsonValue.parse(args),
    },
    { runId, signal: new AbortController().signal },
  );
}

async function expectFileError(
  operation: FsOperation,
  root: string,
  input: unknown,
  code: string,
): Promise<void> {
  const files = new WorkspaceFileSystem(root);
  await expect(files.execute(runId, operation, input, new AbortController().signal)).rejects.toMatchObject({
    code,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(["in-process", "remote"] as const)("workspace tools on the %s backend", (kind) => {
  it("provides identical read, write, edit, list, and search behavior", async () => {
    const root = await workspaceRoot();
    const { backend, close } = await makeBackend(kind, root);
    const tools = new FsTools(backend);
    try {
      expect(tools.getToolSpecs().map(({ toolId }) => toolId)).toEqual([
        "fs.read",
        "fs.write",
        "fs.edit",
        "fs.list",
        "fs.search",
      ]);
      expect(await toolCall(tools, "fs.write", {
        path: "notes.txt",
        content: "alpha\nbeta",
        mode: "create",
      })).toMatchObject({ outcome: "ok" });
      expect(await toolCall(tools, "fs.read", { path: "notes.txt", offset: 6, length: 4 })).toMatchObject({
        outcome: "ok",
        result: { binary: false, content: "beta", offset: 6 },
      });
      expect(await toolCall(tools, "fs.edit", {
        path: "notes.txt",
        edits: [{ oldText: "beta", newText: "gamma" }],
      })).toMatchObject({ outcome: "ok" });
      expect(await toolCall(tools, "fs.list", { path: ".", depth: 0, limit: 10 })).toMatchObject({
        outcome: "ok",
        result: { entries: [{ path: "notes.txt", type: "file" }], truncated: false },
      });
      expect(await toolCall(tools, "fs.search", { query: "gamma", regex: false, limit: 10 })).toMatchObject({
        outcome: "ok",
        result: { matches: [{ path: "notes.txt", line: "gamma", lineNumber: 2 }] },
      });
      expect(await toolCall(tools, "fs.search", {
        query: "g.mma",
        regex: true,
        path: "notes.txt",
        limit: 10,
      })).toMatchObject({
        outcome: "ok",
        result: { matches: [{ path: "notes.txt", lineNumber: 2, line: "gamma" }] },
      });
      expect(tools.describe("fs.read")).toMatchObject({ idempotent: true });
      expect(tools.describe("fs.write", JsonValue.parse({
        path: "notes.txt",
        content: "new",
        mode: "overwrite",
        expectedSha256: "0".repeat(64),
      }))).toMatchObject({ idempotent: true });
      expect(tools.describe("fs.write", JsonValue.parse({
        path: "notes.txt",
        content: "new",
        mode: "overwrite",
      }))).toMatchObject({ idempotent: false });
      expect(tools.describe(Code.parse("fs.unknown"))).toBeUndefined();
      expect(await toolCall(tools, "fs.read", { path: "../outside" })).toMatchObject({
        outcome: "error",
        errorCode: "fs_path_invalid",
        result: null,
      });
    } finally {
      await close();
    }
  });
});

describe("workspace file operation contracts and safety", () => {
  it("enforces input sizes, counts, offsets, depths, limits, and safe regexes", () => {
    expect(FsReadInputSchema.safeParse({ path: "a", length: 256 * 1024 }).success).toBe(true);
    expect(FsReadInputSchema.safeParse({ path: "a", length: 256 * 1024 + 1 }).success).toBe(false);
    expect(FsWriteInputSchema.safeParse({
      path: "a",
      content: "é".repeat(524_289),
      mode: "create",
    }).success).toBe(false);
    expect(FsEditInputSchema.safeParse({
      path: "a",
      edits: Array.from({ length: 21 }, () => ({ oldText: "a", newText: "b" })),
    }).success).toBe(false);
    expect(FsListInputSchema.safeParse({ path: ".", depth: 4, limit: 10 }).success).toBe(false);
    expect(FsSearchInputSchema.safeParse({
      query: "(a+)+$",
      regex: true,
      limit: 10,
    }).success).toBe(false);
    expect(FsSearchInputSchema.safeParse({
      query: "[",
      regex: true,
      limit: 10,
    }).success).toBe(false);
  });

  it("returns only binary metadata and supports byte offsets", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await writeFile(join(project, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(project, "text.txt"), "éclair");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    expect(await files.execute(runId, "read", { path: "binary.dat" }, signal)).toEqual({
      binary: true,
      bytes: 3,
    });
    expect(await files.execute(runId, "read", { path: "text.txt", offset: 3, length: 1 }, signal)).toMatchObject({
      binary: false,
      content: "l",
      offset: 3,
      bytes: 1,
    });
    expect(FsToolResultSchema.safeParse({ binary: true, bytes: 3, path: "secret" }).success).toBe(false);
  });

  // threat: T-12
  it("rejects traversal, absolute paths, symlinks, and all .harness paths", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-outside-")));
    roots.push(outside);
    await writeFile(join(outside, "target.txt"), "unchanged");
    await symlink(join(outside, "target.txt"), join(project, "linked.txt"));

    for (const path of ["../outside", "/etc/passwd", "linked.txt", ".harness/offload/item"]) {
      await expectFileError("read", root, { path }, "fs_path_invalid");
    }
    await expectFileError("write", root, {
      path: ".harness/tmp/item",
      content: "blocked",
      mode: "create",
    }, "fs_path_invalid");
    await expect(readFile(join(outside, "target.txt"), "utf8")).resolves.toBe("unchanged");
  });

  it("enforces edit uniqueness and prevents a preconditioned retry from applying twice", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const path = join(project, "edit.txt");
    await writeFile(path, "first second second");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    await expectFileError("edit", root, {
      path: "edit.txt",
      edits: [{ oldText: "absent", newText: "value" }],
    }, "edit_no_match");
    await expectFileError("edit", root, {
      path: "edit.txt",
      edits: [{ oldText: "second", newText: "third" }],
    }, "edit_ambiguous");

    const originalSha256 = createHash("sha256").update("first second second").digest("hex");
    const input = {
      path: "edit.txt",
      edits: [{ oldText: "first", newText: "updated" }],
      expectedSha256: originalSha256,
    };
    await expect(files.execute(runId, "edit", input, signal)).resolves.toMatchObject({
      path: "edit.txt",
    });
    await expect(files.execute(runId, "edit", input, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("updated second second");
  });

  it("applies write preconditions once and rejects a same-content retry", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await writeFile(join(project, "existing.txt"), "before");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;
    const expectedSha256 = createHash("sha256").update("before").digest("hex");
    const input = {
      path: "existing.txt",
      content: "after",
      mode: "overwrite",
      expectedSha256,
    };
    await files.execute(runId, "write", input, signal);
    await expect(files.execute(runId, "write", input, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
    const unchanged = {
      ...input,
      content: "before",
    };
    await expect(files.execute(runId, "write", unchanged, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
  });

  // threat: T-09
  it("enforces the existing per-file and per-run quotas", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (async () => {
          const path = join(project, `quota-${String(index)}.bin`);
          await writeFile(path, "");
          await truncate(path, 10 * 1024 * 1024);
        })(),
      ),
    );
    const files = new WorkspaceFileSystem(root);
    await expect(files.execute(
      runId,
      "write",
      { path: "over-quota.txt", content: "x", mode: "create" },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "fs_quota_exceeded" });

    const tooLargePath = join(project, "too-large.bin");
    await writeFile(tooLargePath, "");
    await truncate(tooLargePath, 10 * 1024 * 1024 + 1);
    await expect(files.execute(
      runId,
      "read",
      { path: "too-large.bin" },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "fs_quota_exceeded" });
  });

  it("reports bounded list/search results, ignores binary search input, and rejects aborted work", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await mkdir(join(project, "nested", "deeper"), { recursive: true });
    await writeFile(join(project, "nested", "deeper", "match.txt"), "needle\nneedle");
    await writeFile(join(project, "binary.dat"), Buffer.from([0, 0, 1]));
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    await expect(files.execute(runId, "list", { path: ".", depth: 3, limit: 1 }, signal)).resolves.toMatchObject({
      truncated: true,
    });
    await expect(files.execute(
      runId,
      "search",
      { query: "needle", regex: false, path: "nested/deeper/match.txt", limit: 1 },
      signal,
    )).resolves.toMatchObject({ matches: [{ lineNumber: 1 }], truncated: true });
    await expect(files.execute(runId, "search", {
      query: "needle",
      regex: false,
      path: ".",
      limit: 10,
    }, signal)).resolves.toMatchObject({
      matches: [
        { path: "nested/deeper/match.txt", lineNumber: 1 },
        { path: "nested/deeper/match.txt", lineNumber: 2 },
      ],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(files.execute(runId, "read", { path: "binary.dat" }, controller.signal)).rejects.toMatchObject({
      code: "fs_operation_failed",
    });
  });
});
