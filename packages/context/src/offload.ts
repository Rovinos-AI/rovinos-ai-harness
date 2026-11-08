// SPDX-License-Identifier: Apache-2.0
// Size limits and offsets use UTF-8 bytes; returned text pages end at code-point boundaries.
import { z } from "zod";
import {
  HarnessError,
  JsonValue,
  ToolSpecSchema,
  ToolBinaryPayloadSchema,
  type Code,
  type Id as IdValue,
  type JsonValue as JsonValueType,
  type KeyProvider,
  type ToolSpec,
  type PiiActionSummary,
} from "@rovinos/schemas";
import { SystemOffloadIdGenerator } from "./offload-id.js";
import { offloadArtifactResult } from "./offload-artifacts.js";
import { readOffloaded } from "./offload-read.js";
import {
  OffloadedHandleSchema,
  OffloadedStub,
  ReadOffloadedInputSchema,
} from "./offload-schemas.js";
import type { OffloadedHandle } from "./offload-schemas.js";
export {
  OffloadedHandleSchema,
  OffloadedStub,
  ReadOffloadedInputSchema,
  ReadOffloadedResultSchema,
} from "./offload-schemas.js";
export type { OffloadedHandle, ReadOffloadedResult } from "./offload-schemas.js";

const OFFLOAD_DIRECTORY = ".harness/offload/";

/** Workspace-relative range in bytes. */
export interface WorkspaceReadRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * Workspace access used by output offloading.
 *
 * Implementations must keep paths under `.harness/offload/`, reject traversal and
 * absolute paths, and refuse symlinks. Filesystem-backed implementations must
 * resolve the final path and reject any symlink or real path outside the real
 * `.harness/offload/` directory.
 */
export interface WorkspacePort {
  /**
   * Writes bytes to an offload path.
   *
   * @param path - Workspace-relative path below `.harness/offload/`.
   * @param data - Bytes to persist.
   */
  write(path: string, data: Uint8Array): Promise<void>;

  /** Publishes every file in a batch or leaves no batch file visible. */
  writeBatch(
    entries: readonly { readonly path: string; readonly data: Uint8Array }[],
  ): Promise<void>;

  /** Reads bytes from an offload path, optionally selecting a byte range.
   * @param path - Workspace-relative path below `.harness/offload/`.
   * @param range - Optional byte offset and length.
   * @returns A copy of the requested bytes.
   * @throws WorkspaceFileNotFoundError when the file does not exist; ranges beyond EOF return empty bytes.
   */
  read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array>;
}

/** Identifier source used to generate unique offload handles. */
export interface OffloadIdGenerator {
  /** Returns a valid ULID. */
  next(): IdValue;
}

/** Tool call accepted by an offloading decorator. */
export interface OffloadToolCall {
  readonly callId: IdValue;
  readonly toolId: Code;
  readonly args: JsonValueType;
}

/** Context supplied to an offloaded tool call. */
export interface OffloadRunContext {
  readonly runId: IdValue;
  readonly signal: AbortSignal;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
}

/** Result returned by a tool execution. */
export interface OffloadToolExecutionResult {
  readonly artifacts?: readonly {
    readonly partIndex: number;
    readonly target: "data" | "resource.blob";
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }[];
  readonly binary?: boolean;
  readonly metadata?: JsonValueType;
  readonly suspend?: boolean;
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly resultLimitBytes?: number;
  readonly errorCode?: Code;
}

/** Metadata describing retry behavior for a tool. */
export interface OffloadToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

/** Tool port shape accepted by {@link OffloadingToolPort}. */
export interface OffloadToolPortLike {
  /** Sanitizes arguments before durable recording. */
  prepare?(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolCall>;
  /** Returns metadata for a registered tool. */
  describe(toolId: Code, args?: JsonValueType): OffloadToolDescription | undefined;

  /** Returns provider-visible specifications for registered tools, when available. */
  getToolSpecs?(): readonly ToolSpec[];

  /** Executes a validated tool call. */
  execute(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolExecutionResult>;
}

/** Configuration for replacing large tool results with offload stubs. */
export const OffloadingToolOptionsSchema = z
  .object({
    thresholdBytes: z.number().int().nonnegative().default(8192),
    previewChars: z.number().int().nonnegative().default(400),
  })
  .strict();

/** Inferred offloading configuration. */
export type OffloadingToolOptions = z.input<typeof OffloadingToolOptionsSchema>;

/** Error raised when a workspace path is outside the offload directory. */
export class WorkspacePathError extends HarnessError {
  readonly code = "workspace_path_invalid";

  /** Creates an error for an invalid workspace-relative path. */
  constructor() {
    super("Workspace path is invalid.");
  }
}

/** Error raised when an offload file does not exist. */
export class WorkspaceFileNotFoundError extends HarnessError {
  readonly code = "workspace_file_not_found";

  /** Creates an error for an absent workspace file. */
  constructor() {
    super("Workspace file was not found.");
  }
}

function validateWorkspacePath(path: string): void {
  const segments = path.split("/");
  if (
    !path.startsWith(OFFLOAD_DIRECTORY) ||
    path.length === OFFLOAD_DIRECTORY.length ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some(
      (segment, index) => index > 1 && (segment === "." || segment === ".." || segment === ""),
    )
  ) {
    throw new WorkspacePathError();
  }
}

function validateRange(range: WorkspaceReadRange): void {
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length < 0
  ) {
    throw new RangeError("Workspace read range must use non-negative safe integers.");
  }
}

/** In-memory workspace implementation for tests and embedded runs. */
export class InMemoryWorkspace implements WorkspacePort {
  private readonly files = new Map<string, Uint8Array>();

  /** {@inheritDoc WorkspacePort.write} */
  write(path: string, data: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => {
      validateWorkspacePath(path);
      this.files.set(path, data.slice());
    });
  }

  writeBatch(
    entries: readonly { readonly path: string; readonly data: Uint8Array }[],
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const validated: { readonly path: string; readonly data: Uint8Array }[] = entries.map(
        ({ path, data }) => {
          validateWorkspacePath(path);
          if (this.files.has(path)) {
            throw new WorkspacePathError();
          }
          return { path, data: data.slice() };
        },
      );
      if (new Set(validated.map(({ path }) => path)).size !== validated.length) {
        throw new WorkspacePathError();
      }
      for (const { path, data } of validated) {
        this.files.set(path, data);
      }
    });
  }

  /** {@inheritDoc WorkspacePort.read} */
  read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      validateWorkspacePath(path);
      const data = this.files.get(path);
      if (data === undefined) {
        throw new WorkspaceFileNotFoundError();
      }
      if (range === undefined) {
        return data.slice();
      }
      validateRange(range);
      return data.slice(range.offset, range.offset + range.length);
    });
  }
}

/** Tool specification for registering the idempotent `read_offloaded` tool. */
export const READ_OFFLOADED_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: "read_offloaded",
  description: "Read a page of a large tool result or binary artifact from the run workspace.",
  inputSchema: JsonValue.parse(z.toJSONSchema(ReadOffloadedInputSchema)),
});

function offloadPath(handle: string): string {
  return `${OFFLOAD_DIRECTORY}${OffloadedHandleSchema.parse(handle)}.json`;
}

function toolError(errorCode: Code): OffloadToolExecutionResult {
  return { outcome: "error", errorCode, result: null };
}

/** Decorates a tool port to store large results and expose them through `read_offloaded`. */
export class OffloadingToolPort implements OffloadToolPortLike {
  private readonly options: z.infer<typeof OffloadingToolOptionsSchema>;
  private readonly knownSizes = new Map<OffloadedHandle, number>();
  private readonly ids: OffloadIdGenerator;
  private readonly artifactKeyProvider: KeyProvider | undefined;

  /**
   * Wraps an executor with workspace offloading for large tool results.
   * PII tokenization must be applied by `inner` before this decorator.
   * @param inner - Tool port that performs PII tokenization before returning results.
   * @param workspace - Workspace used to persist and page offloaded results.
   * @param options - Byte threshold and preview character limit.
   * @param dependencies - Optional ID generator and artifact encryption key provider.
   */
  constructor(
    private readonly inner: OffloadToolPortLike,
    private readonly workspace: WorkspacePort,
    options: OffloadingToolOptions = {},
    dependencies: {
      readonly ids?: OffloadIdGenerator;
      readonly artifactKeyProvider?: KeyProvider;
    } = {},
  ) {
    this.options = OffloadingToolOptionsSchema.parse(options);
    this.ids = dependencies.ids ?? new SystemOffloadIdGenerator();
    this.artifactKeyProvider = dependencies.artifactKeyProvider;
  }

  /** {@inheritDoc OffloadToolPortLike.describe} */
  describe(toolId: Code, args?: JsonValueType): OffloadToolDescription | undefined {
    if (toolId === "read_offloaded") {
      return { idempotent: true, timeoutMs: 30_000 };
    }
    return this.inner.describe(toolId, args);
  }

  /** {@inheritDoc OffloadToolPortLike.getToolSpecs} */
  getToolSpecs(): readonly ToolSpec[] {
    return [
      ...(this.inner.getToolSpecs?.() ?? []).filter(
        ({ toolId }) => toolId !== READ_OFFLOADED_TOOL_SPEC.toolId,
      ),
      READ_OFFLOADED_TOOL_SPEC,
    ];
  }

  /** Forwards preparation to the inner boundary. */
  async prepare(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolCall> {
    return this.inner.prepare?.(call, context) ?? call;
  }

  /** {@inheritDoc OffloadToolPortLike.execute} */
  async execute(
    call: OffloadToolCall,
    context: OffloadRunContext,
  ): Promise<OffloadToolExecutionResult> {
    if (call.toolId === "read_offloaded") {
      return readOffloaded(
        this.workspace,
        this.knownSizes,
        call,
        { runId: context.runId, keyProvider: this.artifactKeyProvider },
      );
    }

    const execution = await this.inner.execute(call, context);
    return this.offloadRecoveredResult(call, context, execution);
  }

  /** Offloads a recovered result without invoking the underlying tool again. */
  async offloadRecoveredResult(
    call: OffloadToolCall,
    context: OffloadRunContext,
    execution: OffloadToolExecutionResult,
  ): Promise<OffloadToolExecutionResult> {
    if (execution.artifacts !== undefined && execution.artifacts.length > 0) {
      return offloadArtifactResult(
        execution,
        this.workspace,
        {
          ids: this.ids,
          knownSizes: this.knownSizes,
          keyProvider: this.artifactKeyProvider,
          runId: context.runId,
        },
      );
    }
    if (execution.binary === true && !ToolBinaryPayloadSchema.safeParse(execution.result).success) {
      return toolError("pii_input_invalid");
    }

    const serialized = JSON.stringify(execution.result);
    const data = new TextEncoder().encode(serialized);
    if (execution.binary !== true && serialized.length <= this.options.thresholdBytes) {
      return execution;
    }

    const handle = `wf_${this.ids.next()}`;
    await this.workspace.write(offloadPath(handle), data);
    const validatedHandle = OffloadedHandleSchema.parse(handle);
    this.knownSizes.set(validatedHandle, data.byteLength);

    return {
      outcome: execution.outcome,
      ...(execution.suspend === true ? { suspend: true } : {}),
      ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
      result: JsonValue.parse(
        OffloadedStub.parse({
          $offloaded: {
            handle: validatedHandle,
            bytes: data.byteLength,
            preview:
              execution.binary === true
                ? ""
                : Array.from(serialized).slice(0, this.options.previewChars).join(""),
          },
          ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
        }),
      ),
    };
  }
}
