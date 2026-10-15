// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { HarnessError, Id, type Id as IdValue } from "@harness/schemas";
import { WorkspaceFileNotFoundError, WorkspacePathError } from "@harness/context";
import type { WorkspacePort, WorkspaceReadRange } from "@harness/context";
import type { Clock } from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_RECOUNT_INTERVAL_MS = 60_000;
const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Raised when a workspace write exceeds its per-file or per-run byte limit. */
export class WorkspaceQuotaExceededError extends HarnessError {
  readonly code = "workspace_quota_exceeded";

  constructor() {
    super("The workspace quota was exceeded.");
  }
}

/** Raised when the workspace path or file type is unsafe. */
export class SandboxWorkspacePathError extends HarnessError {
  readonly code = "sandbox_workspace_path_invalid";

  constructor() {
    super("The requested workspace path is invalid.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function validateRelativePath(value: string): void {
  const segments = value.split(/[\\/]/u);
  if (
    value.length > 4096 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment === ".." || segment.length > 255)
  ) {
    throw new SandboxWorkspacePathError();
  }
}

/**
 * Resolves a workspace-relative path after validating its parent and every existing component.
 *
 * @param root - Trusted per-run workspace root.
 * @param workspacePath - Relative file or directory path.
 * @returns The canonical in-root path, or an in-root path whose final component does not exist yet.
 */
export async function resolveWorkspacePath(
  root: string,
  workspacePath = ".",
  options: { readonly allowMissing?: boolean } = {},
): Promise<string> {
  validateRelativePath(workspacePath);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new SandboxWorkspacePathError();
  }

  const candidate = resolve(realRoot, workspacePath);
  if (!isWithin(realRoot, candidate)) {
    throw new SandboxWorkspacePathError();
  }
  const parent = await realpath(candidate === realRoot ? realRoot : dirname(candidate)).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  if (!isWithin(realRoot, parent)) {
    throw new SandboxWorkspacePathError();
  }

  const fromRoot = relative(realRoot, candidate);
  let current = realRoot;
  for (const segment of fromRoot.split(sep).filter((part) => part !== "")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new SandboxWorkspacePathError();
      }
    } catch (error) {
      if (error instanceof SandboxWorkspacePathError) {
        throw error;
      }
      if (codeOf(error) !== "ENOENT") {
        throw new SandboxWorkspacePathError();
      }
    }
  }

  try {
    const realCandidate = await realpath(candidate);
    if (!isWithin(realRoot, realCandidate)) {
      throw new SandboxWorkspacePathError();
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof SandboxWorkspacePathError) {
      throw error;
    }
    if (codeOf(error) !== "ENOENT") {
      throw new SandboxWorkspacePathError();
    }
    if (options.allowMissing !== true) {
      throw new SandboxWorkspacePathError();
    }
    return candidate;
  }
}

/** Ensures the documented project and private harness directories exist for a run. */
export async function ensureRunWorkspace(workspacesRoot: string, runId: IdValue): Promise<string> {
  const validatedRunId = Id.parse(runId);
  const runRoot = join(workspacesRoot, validatedRunId);
  await mkdir(runRoot, { recursive: true, mode: 0o2770 });
  await chmod(runRoot, 0o2770);
  for (const directory of [
    join(runRoot, "project"),
    join(runRoot, ".harness"),
    join(runRoot, ".harness", "offload"),
    join(runRoot, ".harness", "tmp"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o2770 });
    await chmod(directory, 0o2770);
  }
  return join(runRoot, "project");
}

/** Removes only the run-specific scratch directory, leaving project and offload data intact. */
export async function clearRunScratch(workspacesRoot: string, runId: IdValue): Promise<void> {
  const validatedRunId = Id.parse(runId);
  await rm(join(workspacesRoot, validatedRunId, ".harness", "tmp"), {
    force: true,
    recursive: true,
  });
  await mkdir(join(workspacesRoot, validatedRunId, ".harness", "tmp"), {
    mode: 0o2770,
    recursive: true,
  });
}

/** Filesystem-backed offload workspace bound to one run and enforcing byte quotas. */
export class FsWorkspace implements WorkspacePort {
  readonly #runRoot: string;
  readonly #workspaceRoot: string;
  readonly #runId: IdValue;
  readonly #maxFileBytes: number;
  readonly #quotaBytes: number;
  readonly #recountIntervalMs: number;
  readonly #clock: Clock;
  #usedBytes = 0;
  #lastRecount = Number.NEGATIVE_INFINITY;
  #ready: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();

  /**
   * Creates a workspace for one run.
   *
   * @param options - Shared workspace volume, run ID, quota, and clock settings.
   */
  constructor(options: {
    readonly workspaceRoot: string;
    readonly runId: IdValue;
    readonly maxFileBytes?: number;
    readonly quotaBytes?: number;
    readonly recountIntervalMs?: number;
    readonly clock?: Clock;
  }) {
    this.#runId = Id.parse(options.runId);
    this.#workspaceRoot = options.workspaceRoot;
    this.#runRoot = join(options.workspaceRoot, this.#runId);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#quotaBytes = options.quotaBytes ?? DEFAULT_RUN_QUOTA_BYTES;
    this.#recountIntervalMs = options.recountIntervalMs ?? DEFAULT_RECOUNT_INTERVAL_MS;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    if (
      !Number.isSafeInteger(this.#maxFileBytes) ||
      this.#maxFileBytes < 0 ||
      !Number.isSafeInteger(this.#quotaBytes) ||
      this.#quotaBytes < 0 ||
      !Number.isSafeInteger(this.#recountIntervalMs) ||
      this.#recountIntervalMs < 0
    ) {
      throw new RangeError("Workspace limits must be non-negative safe integers.");
    }
  }

  /** {@inheritDoc WorkspacePort.write} */
  write(path: string, data: Uint8Array): Promise<void> {
    const write = this.#writes.then(() => this.#write(path, data));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #write(path: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > this.#maxFileBytes) {
      throw new WorkspaceQuotaExceededError();
    }
    await this.#ensureReady();
    const filePath = await this.#resolveOffloadPath(path, true);
    const currentBytes = await this.#fileSize(filePath);
    const nextBytes = this.#usedBytes - currentBytes + data.byteLength;
    if (nextBytes > this.#quotaBytes) {
      throw new WorkspaceQuotaExceededError();
    }
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      0o660,
    )
      .catch(() => {
        throw new WorkspacePathError();
      });
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    this.#usedBytes = nextBytes;
  }

  /** {@inheritDoc WorkspacePort.read} */
  async read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array> {
    await this.#ensureReady();
    if (range !== undefined) {
      if (
        !Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.length) ||
        range.offset < 0 ||
        range.length < 0
      ) {
        throw new RangeError("Workspace read range must use non-negative safe integers.");
      }
    }
    const filePath = await this.#resolveOffloadPath(path, true);
    const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") {
        throw new WorkspaceFileNotFoundError();
      }
      throw new WorkspacePathError();
    });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.#maxFileBytes) {
        throw new WorkspaceQuotaExceededError();
      }
      const bytes = await handle.readFile();
      return range === undefined
        ? bytes
        : bytes.subarray(range.offset, range.offset + range.length);
    } finally {
      await handle.close();
    }
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= ensureRunWorkspace(this.#workspaceRoot, this.#runId).then(async () => {
      this.#usedBytes = await this.#recount();
      this.#lastRecount = this.#clock.now();
    });
    await this.#ready;
    if (this.#clock.now() - this.#lastRecount >= this.#recountIntervalMs) {
      this.#usedBytes = await this.#recount();
      this.#lastRecount = this.#clock.now();
    }
  }

  async #resolveOffloadPath(path: string, allowMissing = false): Promise<string> {
    if (!path.startsWith(".harness/offload/")) {
      throw new WorkspacePathError();
    }
    const resolved = await resolveWorkspacePath(this.#runRoot, path, { allowMissing });
    const offloadRoot = await realpath(join(this.#runRoot, ".harness", "offload"));
    if (!isWithin(offloadRoot, resolved)) {
      throw new WorkspacePathError();
    }
    return resolved;
  }

  async #fileSize(filePath: string): Promise<number> {
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new WorkspacePathError();
      }
      return info.size;
    } catch (error) {
      if (codeOf(error) === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async #recount(): Promise<number> {
    const walk = async (directory: string): Promise<number> => {
      let total = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new WorkspacePathError();
        }
        if (info.isDirectory()) {
          total += await walk(path);
        } else if (info.isFile()) {
          total += info.size;
        }
        if (total > this.#quotaBytes) {
          throw new WorkspaceQuotaExceededError();
        }
      }
      return total;
    };
    return walk(this.#runRoot);
  }
}

/** Activates a run's directory for the shared runner group. */
export async function activateRunWorkspace(
  workspacesRoot: string,
  runId: IdValue,
): Promise<string> {
  const project = await ensureRunWorkspace(workspacesRoot, runId);
  await chmod(join(workspacesRoot, Id.parse(runId)), 0o2770);
  return project;
}

/** Locks a completed run's top-level directory away from the execution group. */
export async function lockRunWorkspace(workspacesRoot: string, runId: IdValue): Promise<void> {
  await chmod(join(workspacesRoot, Id.parse(runId)), 0o700).catch(() => undefined);
}
