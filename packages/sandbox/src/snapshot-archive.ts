// SPDX-License-Identifier: Apache-2.0
// cspell:ignore linkpath
import { HarnessError, Id } from "@rovinos/schemas";
import type { WorkspaceRef } from "@rovinos/schemas";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, readlink, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { ReadEntry } from "tar";

const WORKSPACE_REF_PATTERN = /^ws:([0-9A-HJKMNP-TV-Z]{26}):([a-f0-9]{16})$/u;

/** Error raised when a workspace snapshot cannot be read or restored safely. */
export class WorkspaceSnapshotError extends HarnessError {
  readonly code = "workspace_snapshot_invalid";

  constructor() {
    super("The workspace snapshot is invalid.");
  }
}

/** Error raised when a snapshot exceeds its configured size limit. */
export class SnapshotTooLargeError extends HarnessError {
  readonly code = "snapshot_too_large";

  constructor() {
    super("The workspace snapshot exceeds its size limit.");
  }
}

/** Error raised when a snapshot archive contains an unsafe entry. */
export class UnsafeWorkspaceSnapshotError extends HarnessError {
  readonly code = "workspace_snapshot_unsafe";

  constructor() {
    super("The workspace snapshot contains an unsafe entry.");
  }
}

/** Splits a validated workspace reference into its snapshot ID and stored-byte digest. */
export function workspaceSnapshotRefParts(ref: WorkspaceRef): {
  snapshotId: Id;
  digest: string;
} {
  const match = WORKSPACE_REF_PATTERN.exec(ref);
  const snapshotId = match?.[1];
  const digest = match?.[2];
  if (snapshotId === undefined || digest === undefined) {
    throw new WorkspaceSnapshotError();
  }
  return { snapshotId: Id.parse(snapshotId), digest };
}

function isSafeArchivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.length <= 4096 &&
    !normalized.includes("\0") &&
    !normalized.startsWith("/") &&
    !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/u.test(path) &&
    !normalized.split("/").some((segment) => segment === ".." || segment.length > 255)
  );
}

function archiveRelativePath(path: string): string {
  if (!isSafeArchivePath(path)) {
    throw new UnsafeWorkspaceSnapshotError();
  }
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//u, "");
}

function resolveTargetWithinRoot(
  base: string,
  target: string,
  symbolicLinks: ReadonlySet<string> = new Set(),
): string {
  let resolved = posix.normalize(base);
  for (const segment of target.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (symbolicLinks.has(resolved)) {
      throw new UnsafeWorkspaceSnapshotError();
    }
    if (segment === ".." && resolved === ".") {
      throw new UnsafeWorkspaceSnapshotError();
    }
    resolved = segment === ".." ? posix.dirname(resolved) : posix.join(resolved, segment);
    if (resolved === "") {
      resolved = ".";
    }
    if (symbolicLinks.has(resolved)) {
      throw new UnsafeWorkspaceSnapshotError();
    }
  }
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) {
    throw new UnsafeWorkspaceSnapshotError();
  }
  return resolved;
}

function resolveLinkTarget(
  path: string,
  target: string,
  hardLink: boolean,
  symbolicLinks: ReadonlySet<string> = new Set(),
): string {
  const normalized = target.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    win32.isAbsolute(target) ||
    /^[A-Za-z]:/u.test(target)
  ) {
    throw new UnsafeWorkspaceSnapshotError();
  }
  const base = hardLink ? "." : dirname(path);
  return archiveRelativePath(resolveTargetWithinRoot(base, normalized, symbolicLinks));
}

/** Rejects filesystem entries that could not be restored safely or within configured limits. */
export async function assertWorkspaceArchiveLimits(
  runRoot: string,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): Promise<void> {
  let totalBytes = 0;
  const symlinkEntries: { readonly path: string; readonly target: string }[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const relativePath = relativeDirectory === "." ? name : `${relativeDirectory}/${name}`;
      if (relativePath === ".harness/tmp" || relativePath.startsWith(".harness/tmp/")) {
        continue;
      }
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        symlinkEntries.push({ path: relativePath, target: await readlink(path) });
      } else if (info.isDirectory()) {
        await walk(path, relativePath);
      } else if (info.isFile()) {
        totalBytes += info.size;
        if (info.size > maxFileBytes || totalBytes > maxSnapshotBytes) {
          throw new SnapshotTooLargeError();
        }
      } else {
        throw new UnsafeWorkspaceSnapshotError();
      }
    }
  };
  await walk(runRoot, ".");
  const symbolicLinks = new Set(symlinkEntries.map(({ path }) => path));
  for (const entry of symlinkEntries) {
    resolveLinkTarget(entry.path, entry.target, false, symbolicLinks);
  }
}

/** Compresses the workspace while excluding ephemeral per-run scratch files. */
export function createWorkspaceArchive(runRoot: string): Readable {
  try {
    return Readable.from(
      tar.c(
        {
          cwd: runRoot,
          gzip: true,
          portable: true,
          filter: (path) => {
            const segments = path
              .replaceAll("\\", "/")
              .split("/")
              .filter((segment) => segment !== "" && segment !== ".");
            return !(segments[0] === ".harness" && segments[1] === "tmp");
          },
        },
        ["."],
      ),
    );
  } catch {
    throw new WorkspaceSnapshotError();
  }
}

interface ArchiveExtractionState {
  totalBytes: number;
  rootMode?: number;
  rejection?: HarnessError;
  readonly symbolicLinks: Set<string>;
  readonly files: Set<string>;
  readonly paths: Set<string>;
}

type ArchiveFilterEntry = Parameters<NonNullable<tar.TarOptionsWithAliases["filter"]>>[1];

function rejectArchiveEntry(state: ArchiveExtractionState, error: HarnessError): false {
  Object.assign(state, { rejection: state.rejection ?? error });
  return false;
}

function resolveArchiveEntryPath(
  entry: ArchiveFilterEntry,
  state: ArchiveExtractionState,
): string | undefined {
  if (!("type" in entry)) {
    rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    return undefined;
  }
  try {
    const path = archiveRelativePath(entry.path);
    if (path === ".snapshot-preflight.tmp") {
      throw new UnsafeWorkspaceSnapshotError();
    }
    return path;
  } catch {
    rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    return undefined;
  }
}

function entryHasAllowedType(entry: ArchiveFilterEntry): entry is ReadEntry {
  return (
    "type" in entry &&
    (entry.type === "Directory" ||
      entry.type === "File" ||
      entry.type === "OldFile" ||
      entry.type === "SymbolicLink" ||
      entry.type === "Link")
  );
}

function entryFitsSnapshotLimits(
  entry: ReadEntry,
  state: ArchiveExtractionState,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): boolean {
  if (
    !("type" in entry) ||
    entry.type === "Directory" ||
    entry.type === "SymbolicLink" ||
    entry.type === "Link"
  ) {
    return true;
  }
  const totalBytes = state.totalBytes + entry.size;
  Object.assign(state, { totalBytes });
  if (entry.size > maxFileBytes || totalBytes > maxSnapshotBytes) {
    return rejectArchiveEntry(state, new SnapshotTooLargeError());
  }
  return true;
}

function hasSymlinkAncestor(relativePath: string, state: ArchiveExtractionState): boolean {
  const ancestors = relativePath.split("/");
  ancestors.pop();
  let ancestorPath = "";
  for (const ancestor of ancestors) {
    ancestorPath = ancestorPath.length === 0 ? ancestor : `${ancestorPath}/${ancestor}`;
    if (state.symbolicLinks.has(ancestorPath)) {
      return true;
    }
  }
  return false;
}

function registerArchiveEntry(
  entry: ReadEntry,
  relativePath: string,
  state: ArchiveExtractionState,
): boolean {
  if (entry.type === "SymbolicLink" || entry.type === "Link") {
    const linkTarget = "linkpath" in entry ? entry.linkpath : undefined;
    if (linkTarget === undefined) {
      return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    }
    try {
      const target = resolveLinkTarget(
        relativePath,
        linkTarget,
        entry.type === "Link",
        state.symbolicLinks,
      );
      if (entry.type === "Link" && !state.files.has(target)) {
        return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
      }
      if (entry.type === "SymbolicLink") {
        state.symbolicLinks.add(relativePath);
      } else {
        state.files.add(relativePath);
      }
    } catch {
      return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
    }
  } else if (entry.type === "File" || entry.type === "OldFile") {
    state.files.add(relativePath);
  }
  return true;
}

function filterArchiveEntry(
  entry: ArchiveFilterEntry,
  state: ArchiveExtractionState,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): boolean {
  const relativePath = resolveArchiveEntryPath(entry, state);
  if (relativePath === undefined) {
    return false;
  }
  if (!entryHasAllowedType(entry)) {
    return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
  }
  if (hasSymlinkAncestor(relativePath, state)) {
    return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
  }
  if (state.paths.has(relativePath)) {
    return rejectArchiveEntry(state, new UnsafeWorkspaceSnapshotError());
  }
  if (!registerArchiveEntry(entry, relativePath, state)) {
    return false;
  }
  if (!entryFitsSnapshotLimits(entry, state, maxFileBytes, maxSnapshotBytes)) {
    return false;
  }
  const mode = (entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644)) & 0o777;
  Object.assign(entry, { mode });
  if (relativePath === ".") {
    Object.assign(state, { rootMode: mode });
  }
  state.paths.add(relativePath);
  return true;
}

async function validateArchiveLinkTargets(archivePath: string): Promise<void> {
  const links: { readonly path: string; readonly target: string; readonly hardLink: boolean }[] =
    [];
  await tar.t({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        if (entry.linkpath === undefined) {
          throw new UnsafeWorkspaceSnapshotError();
        }
        links.push({
          path: archiveRelativePath(entry.path),
          target: entry.linkpath,
          hardLink: entry.type === "Link",
        });
      }
    },
  });
  const symbolicLinks = new Set(
    links.filter((entry) => !entry.hardLink).map((entry) => entry.path),
  );
  for (const entry of links) {
    resolveLinkTarget(entry.path, entry.target, entry.hardLink, symbolicLinks);
  }
}

/** Safely extracts archive entries into a private temporary workspace directory. */
export async function extractWorkspaceArchive(
  archive: Buffer | Readable,
  destination: string,
  maxFileBytes: number,
  maxSnapshotBytes: number,
): Promise<void> {
  const state: ArchiveExtractionState = {
    totalBytes: 0,
    symbolicLinks: new Set(),
    files: new Set(),
    paths: new Set(),
  };
  const archivePath = join(destination, ".snapshot-preflight.tmp");
  try {
    await pipeline(
      Buffer.isBuffer(archive) ? Readable.from([archive]) : archive,
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    );
    await validateArchiveLinkTargets(archivePath);
    const extractor = tar.x({
      cwd: destination,
      strict: true,
      preservePaths: true,
      preserveOwner: false,
      unlink: true,
      chmod: true,
      processUmask: 0,
      maxDecompressionRatio: 1000,
      filter: (_path, entry) => filterArchiveEntry(entry, state, maxFileBytes, maxSnapshotBytes),
    });
    await pipeline(createReadStream(archivePath), extractor);
    if (state.rejection !== undefined) {
      throw state.rejection;
    }
    await chmod(destination, state.rootMode ?? 0o700);
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new WorkspaceSnapshotError();
  } finally {
    await rm(archivePath, { force: true });
  }
}
