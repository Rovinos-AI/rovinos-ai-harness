// SPDX-License-Identifier: Apache-2.0
// Size limits and offsets use UTF-8 bytes; returned text pages end at code-point boundaries.
import { JsonValue, type Code } from "@rovinos/schemas";
import {
  OffloadedHandleSchema,
  ReadOffloadedInputSchema,
  ReadOffloadedResultSchema,
} from "./offload-schemas.js";
import type { OffloadedHandle } from "./offload-schemas.js";
import type { OffloadToolCall, OffloadToolExecutionResult, WorkspacePort } from "./offload.js";

const MAX_READ_BYTES = 16 * 1024;
const MAX_BASE64_READ_BYTES = (MAX_READ_BYTES / 4) * 3;
const OFFLOAD_DIRECTORY = ".harness/offload/";

interface LoadedOffloadPage {
  readonly page: Uint8Array;
  readonly totalBytes: number;
}

interface LoadOffloadPageOptions {
  readonly workspace: WorkspacePort;
  readonly handle: OffloadedHandle;
  readonly encoding: "text" | "base64";
  readonly knownSizes: Map<OffloadedHandle, number>;
  readonly offset: number;
  readonly length: number;
}

function toolError(errorCode: Code): OffloadToolExecutionResult {
  return { outcome: "error", errorCode, result: null };
}

function offloadPath(handle: OffloadedHandle): string {
  return `${OFFLOAD_DIRECTORY}${OffloadedHandleSchema.parse(handle)}.json`;
}

function binaryArtifactPath(handle: OffloadedHandle): string {
  return `${OFFLOAD_DIRECTORY}${OffloadedHandleSchema.parse(handle)}.bin`;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "workspace_file_not_found";
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function expectedUtf8Length(leadByte: number): number {
  if (leadByte <= 0x7f) {
    return 1;
  }
  if (leadByte >= 0xc2 && leadByte <= 0xdf) {
    return 2;
  }
  if (leadByte >= 0xe0 && leadByte <= 0xef) {
    return 3;
  }
  if (leadByte >= 0xf0 && leadByte <= 0xf4) {
    return 4;
  }
  return 1;
}

function incompleteUtf8TailStart(bytes: Uint8Array): number {
  let start = bytes.byteLength - 1;
  while (start >= 0 && isContinuationByte(bytes[start] ?? 0)) {
    start -= 1;
  }
  if (start < 0) {
    return bytes.byteLength;
  }
  const expectedLength = expectedUtf8Length(bytes[start] ?? 0);
  return bytes.byteLength - start < expectedLength ? start : bytes.byteLength;
}

async function hasWorkspaceByte(
  workspace: WorkspacePort,
  path: string,
  offset: number,
): Promise<boolean> {
  return (await workspace.read(path, { offset, length: 1 })).byteLength > 0;
}

async function findWorkspaceFileSize(workspace: WorkspacePort, path: string): Promise<number> {
  let lowerBound = 0;
  let upperBound = 1;
  while (await hasWorkspaceByte(workspace, path, upperBound)) {
    if (upperBound === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Workspace file exceeds the supported size.");
    }
    lowerBound = upperBound + 1;
    upperBound = Math.min(lowerBound * 2, Number.MAX_SAFE_INTEGER);
  }

  while (lowerBound < upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    if (await hasWorkspaceByte(workspace, path, midpoint)) {
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint;
    }
  }
  return lowerBound;
}

async function loadOffloadPage(options: LoadOffloadPageOptions): Promise<LoadedOffloadPage> {
  const { workspace, handle, knownSizes, offset, length, encoding } = options;
  const path = encoding === "base64" ? binaryArtifactPath(handle) : offloadPath(handle);
  let totalBytes = knownSizes.get(handle);
  if (totalBytes === undefined) {
    totalBytes = await findWorkspaceFileSize(workspace, path);
    knownSizes.set(handle, totalBytes);
  }
  return {
    page: await workspace.read(path, { offset, length }),
    totalBytes,
  };
}

interface CompleteUtf8PageOptions {
  readonly workspace: WorkspacePort;
  readonly handle: OffloadedHandle;
  readonly offset: number;
  readonly length: number;
  readonly page: Uint8Array;
}

interface CompletePageOptions extends CompleteUtf8PageOptions {
  readonly encoding: "text" | "base64";
}

async function completeUtf8Page(options: CompleteUtf8PageOptions): Promise<Uint8Array> {
  const { workspace, handle, offset, length, page } = options;
  const boundedPage = page.byteLength > MAX_READ_BYTES ? page.slice(0, MAX_READ_BYTES) : page;
  const incompleteTailStart = incompleteUtf8TailStart(boundedPage);
  if (incompleteTailStart === boundedPage.byteLength) {
    return boundedPage;
  }

  const incompleteLength = boundedPage.byteLength - incompleteTailStart;
  const remainingLength =
    expectedUtf8Length(boundedPage[incompleteTailStart] ?? 0) - incompleteLength;
  if (
    length >= MAX_READ_BYTES ||
    remainingLength <= 0 ||
    boundedPage.byteLength + remainingLength > MAX_READ_BYTES
  ) {
    return boundedPage.slice(0, incompleteTailStart);
  }

  const remaining = await workspace.read(offloadPath(handle), {
    offset: offset + boundedPage.byteLength,
    length: remainingLength,
  });
  if (remaining.byteLength !== remainingLength) {
    return boundedPage.slice(0, incompleteTailStart);
  }

  const combined = new Uint8Array(boundedPage.byteLength + remaining.byteLength);
  combined.set(boundedPage);
  combined.set(remaining, boundedPage.byteLength);
  return combined;
}

async function completePage(options: CompletePageOptions): Promise<Uint8Array> {
  if (options.encoding === "base64") {
    return options.page;
  }
  return completeUtf8Page(options);
}

function pageContent(page: Uint8Array, encoding: "text" | "base64"): string {
  if (encoding === "base64") {
    return Buffer.from(page).toString("base64");
  }
  return new TextDecoder().decode(page);
}

/** Reads a bounded page from a run-scoped offloaded result or binary artifact. */
export async function readOffloaded(
  workspace: WorkspacePort,
  knownSizes: Map<OffloadedHandle, number>,
  call: OffloadToolCall,
): Promise<OffloadToolExecutionResult> {
  const input = ReadOffloadedInputSchema.safeParse(call.args);
  if (!input.success) {
    return toolError("invalid_arguments");
  }

  const { handle, encoding } = input.data;
  const offset = input.data.offset ?? 0;
  const maxBytes = encoding === "base64" ? MAX_BASE64_READ_BYTES : MAX_READ_BYTES;
  const length = Math.min(input.data.length ?? maxBytes, maxBytes);
  let loaded: LoadedOffloadPage;
  try {
    loaded = await loadOffloadPage({ workspace, handle, encoding, knownSizes, offset, length });
  } catch (error) {
    if (isFileNotFound(error)) {
      return toolError("handle_not_found");
    }
    throw error;
  }

  if (encoding === "text" && loaded.page.length > 0 && isContinuationByte(loaded.page[0] ?? 0)) {
    return toolError("invalid_offset");
  }
  const page = await completePage({
    workspace,
    handle,
    encoding,
    offset,
    length,
    page: loaded.page,
  });
  const nextOffset = offset + page.byteLength;
  const result = {
    data: pageContent(page, encoding),
    ...(encoding === "base64" ? { encoding } : {}),
    ...(page.byteLength > 0 && nextOffset < loaded.totalBytes ? { nextOffset } : {}),
    totalBytes: loaded.totalBytes,
  };
  ReadOffloadedResultSchema.parse(result);
  return { outcome: "ok", result: JsonValue.parse(result) };
}
