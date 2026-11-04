// SPDX-License-Identifier: Apache-2.0
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { HarnessError } from "@rovinos/schemas";

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Tests whether a resolved path is the root itself or one of its descendants. */
export function isWithinWorkspace(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

/** Raised when a workspace path or file type is unsafe. */
export class SandboxWorkspacePathError extends HarnessError {
  readonly code = "sandbox_workspace_path_invalid";

  constructor() {
    super("The requested workspace path is invalid.");
  }
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

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, candidate)
    .split(sep)
    .filter((part) => part !== "")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
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
}

async function resolveFinalPath(
  root: string,
  candidate: string,
  allowMissing: boolean,
): Promise<string> {
  try {
    const resolved = await realpath(candidate);
    if (!isWithinWorkspace(root, resolved)) {
      throw new SandboxWorkspacePathError();
    }
    return resolved;
  } catch (error) {
    if (allowMissing && codeOf(error) === "ENOENT") {
      return candidate;
    }
    throw error instanceof SandboxWorkspacePathError ? error : new SandboxWorkspacePathError();
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
  const realRoot = await realpath(root).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  const candidate = resolve(realRoot, workspacePath);
  if (!isWithinWorkspace(realRoot, candidate)) {
    throw new SandboxWorkspacePathError();
  }
  const parentPath = candidate === realRoot ? realRoot : dirname(candidate);
  const parent = await realpath(parentPath).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  if (!isWithinWorkspace(realRoot, parent)) {
    throw new SandboxWorkspacePathError();
  }
  await assertNoSymlinkComponents(realRoot, candidate);
  return resolveFinalPath(realRoot, candidate, options.allowMissing === true);
}
