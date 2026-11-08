// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Id,
  McpResultArtifactReferenceSchema,
  McpToolResultEnvelopeSchema,
  SequentialIdGenerator,
  type Event,
  type JsonValue,
  type KeyProvider,
} from "@rovinos/schemas";
import {
  InMemoryWorkspace,
  NaiveStrategy,
  OffloadedStub,
  OffloadingToolPort,
  READ_OFFLOADED_TOOL_SPEC,
  ReadOffloadedInputSchema,
  ReadOffloadedResultSchema,
  WorkspaceFileNotFoundError,
  WorkspacePathError,
  type OffloadToolCall,
  type OffloadToolExecutionResult,
  type OffloadToolPortLike,
  type WorkspacePort,
} from "./index.js";

const runId = Id.parse("00000000000000000000000000");
const callId = Id.parse("11111111111111111111111111");
const signal = new AbortController().signal;
const context = { runId, signal };
const call = (toolId = "sample_tool", args: JsonValue = {}): OffloadToolCall => ({
  callId,
  toolId,
  args,
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyProvider(
  keys: ReadonlyMap<string, Uint8Array>,
  currentKeyId: () => string = () => "test_key",
): KeyProvider {
  return {
    currentKeyId,
    getKey: (keyId) => {
      const key = keys.get(keyId);
      return key === undefined
        ? Promise.reject(new Error("key_not_found"))
        : Promise.resolve(key);
    },
  };
}

function firstArtifactReference(value: JsonValue): ReturnType<
  typeof McpResultArtifactReferenceSchema.parse
> {
  const envelope = McpToolResultEnvelopeSchema.parse(value);
  const part = envelope.parts[0];
  if (part === undefined || part === null || typeof part !== "object" || Array.isArray(part)) {
    throw new Error("Missing artifact part.");
  }
  return McpResultArtifactReferenceSchema.parse(part.artifact);
}

function fakePort(result: JsonValue): {
  readonly inner: OffloadToolPortLike;
  readonly execution: OffloadToolExecutionResult;
  readonly execute: OffloadToolPortLike["execute"];
} {
  const execution: OffloadToolExecutionResult = { outcome: "ok", result };
  const execute = vi.fn<OffloadToolPortLike["execute"]>(() => Promise.resolve(execution));
  const inner: OffloadToolPortLike = {
    describe: (toolId) =>
      toolId === "sample_tool" ? { idempotent: false, timeoutMs: 1000 } : undefined,
    execute,
  };
  return { inner, execution, execute };
}

function toolResult(seq: number, result: JsonValue, resultCallId = callId): Event {
  return {
    runId,
    seq,
    ts: seq,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: "22222222222222222222222222",
    type: "tool_result",
    callId: resultCallId,
    toolId: "sample_tool",
    outcome: "ok",
    latencyMs: 0,
    result,
  };
}

describe("InMemoryWorkspace", () => {
  it("copies bytes on write and read and supports bounded ranges", async () => {
    const workspace = new InMemoryWorkspace();
    const original = new TextEncoder().encode("abcdef");
    await workspace.write(".harness/offload/file.json", original);
    original[0] = 0;

    const range = await workspace.read(".harness/offload/file.json", { offset: 2, length: 3 });
    expect(new TextDecoder().decode(range)).toBe("cde");
    range[0] = 0;
    expect(new TextDecoder().decode(await workspace.read(".harness/offload/file.json"))).toBe(
      "abcdef",
    );
    await expect(
      workspace.read(".harness/offload/file.json", { offset: -1, length: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      workspace.read(".harness/offload/file.json", { offset: 0, length: 1.5 }),
    ).rejects.toThrow(RangeError);
  });

  it.each([
    "../secret",
    "/.harness/offload/file.json",
    "C:/workspace/.harness/offload/file.json",
    ".harness/offload/../secret",
    ".harness/offload//file.json",
    ".harness/offload\\file.json",
    ".harness/other/file.json",
  ])("rejects unsafe path %s", async (path) => {
    const workspace = new InMemoryWorkspace();
    await expect(workspace.write(path, new Uint8Array())).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it("rejects a valid-looking path to a missing file", async () => {
    await expect(
      new InMemoryWorkspace().read(".harness/offload/missing.json"),
    ).rejects.toBeInstanceOf(WorkspaceFileNotFoundError);
  });
});

describe("OffloadingToolPort", () => {
  it("writes ordered binary artifacts in a batch and substitutes per-part references", async () => {
    const workspace = new InMemoryWorkspace();
    const writeBatch = vi.spyOn(workspace, "writeBatch");
    const imageBytes = new Uint8Array([0, 255, 7]);
    const resourceBytes = new Uint8Array([1, 2]);
    const keys = new Map([["test_key", new Uint8Array(32).fill(7)]]);
    const envelope: JsonValue = {
      format: "mcp-tool-result",
      version: 1,
      isError: false,
      parts: [
        { type: "text", text: "before" },
        { type: "image", mimeType: "image/png" },
        {
          type: "resource",
          resource: { uri: "file:///synthetic", mimeType: "application/octet-stream" },
        },
        { type: "text", text: "after" },
      ],
      structuredContent: { status: "ok" },
    };
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: envelope,
          resultLimitBytes: 2_000,
          artifacts: [
            {
              partIndex: 1,
              target: "data",
              mimeType: "image/png",
              bytes: imageBytes,
              sha256: sha256(imageBytes),
            },
            {
              partIndex: 2,
              target: "resource.blob",
              mimeType: "application/octet-stream",
              bytes: resourceBytes,
              sha256: sha256(resourceBytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(
      inner,
      workspace,
      {},
      { ids: new SequentialIdGenerator(), artifactKeyProvider: keyProvider(keys) },
    );

    const execution = await port.execute(call(), context);
    const result = McpToolResultEnvelopeSchema.parse(execution.result);
    const imageReference = McpResultArtifactReferenceSchema.parse(
      result.parts[1] !== null &&
        typeof result.parts[1] === "object" &&
        !Array.isArray(result.parts[1])
        ? result.parts[1].artifact
        : undefined,
    );
    const resourcePart = result.parts[2];
    if (
      resourcePart === null ||
      typeof resourcePart !== "object" ||
      Array.isArray(resourcePart) ||
      resourcePart.resource === null ||
      typeof resourcePart.resource !== "object" ||
      Array.isArray(resourcePart.resource)
    ) {
      throw new Error("Missing resource result part.");
    }
    const resourceReference = McpResultArtifactReferenceSchema.parse(
      resourcePart.resource.artifact,
    );

    expect(result.parts[0]).toEqual({ type: "text", text: "before" });
    expect(result.parts[3]).toEqual({ type: "text", text: "after" });
    expect(resourcePart.resource.uri).toBe("file:///synthetic");
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const storedImage = await workspace.read(`.harness/offload/${imageReference.handle}.bin`);
    const storedResource = await workspace.read(`.harness/offload/${resourceReference.handle}.bin`);
    expect(storedImage).not.toEqual(imageBytes);
    expect(storedResource).not.toEqual(resourceBytes);
    expect(Buffer.from(storedImage).includes(Buffer.from(imageBytes))).toBe(false);
    expect(Buffer.from(storedResource).includes(Buffer.from(resourceBytes))).toBe(false);
    expect(imageReference.sha256).toBe(sha256(imageBytes));
    expect(resourceReference.sha256).toBe(sha256(resourceBytes));
    expect(JSON.stringify(execution)).not.toContain(Buffer.from(imageBytes).toString("base64"));
    expect(JSON.stringify(execution)).not.toContain(Buffer.from(resourceBytes).toString("base64"));

    const page = await port.execute(
      call("read_offloaded", { handle: imageReference.handle, encoding: "base64" }),
      context,
    );
    const decoded = ReadOffloadedResultSchema.parse(page.result);
    expect(decoded.encoding).toBe("base64");
    expect([...Buffer.from(decoded.data, "base64")]).toEqual([...imageBytes]);
  });

  it("denies artifact reads from a different run", async () => {
    const workspace = new InMemoryWorkspace();
    const bytes = new Uint8Array([11, 22, 33]);
    const keys = keyProvider(new Map([["test_key", new Uint8Array(32).fill(9)]]));
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "blob", mimeType: "application/octet-stream" }],
          },
          artifacts: [
            {
              partIndex: 0,
              target: "data",
              mimeType: "application/octet-stream",
              bytes,
              sha256: sha256(bytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(inner, workspace, {}, {
      ids: new SequentialIdGenerator(),
      artifactKeyProvider: keys,
    });
    const result = await port.execute(call(), context);
    const reference = firstArtifactReference(result.result);

    await expect(
      port.execute(
        call("read_offloaded", { handle: reference.handle, encoding: "base64" }),
        { ...context, runId: Id.parse("00000000000000000000000099") },
      ),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "artifact_decrypt_failed" });
  });

  it("fails closed when the current encryption key is unavailable", async () => {
    const workspace = new InMemoryWorkspace();
    const writeBatch = vi.spyOn(workspace, "writeBatch");
    const bytes = new Uint8Array([1, 2, 3]);
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "blob", mimeType: "application/octet-stream" }],
          },
          artifacts: [
            {
              partIndex: 0,
              target: "data",
              mimeType: "application/octet-stream",
              bytes,
              sha256: sha256(bytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(
      inner,
      workspace,
      {},
      { ids: new SequentialIdGenerator(), artifactKeyProvider: keyProvider(new Map()) },
    );

    await expect(port.execute(call(), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "artifact_encrypt_failed",
    });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("reads artifacts encrypted with a prior key after rotation", async () => {
    const workspace = new InMemoryWorkspace();
    let activeKey = "old_key";
    const keys = keyProvider(
      new Map([
        ["old_key", new Uint8Array(32).fill(1)],
        ["new_key", new Uint8Array(32).fill(2)],
      ]),
      () => activeKey,
    );
    const bytes = new Uint8Array([31, 32, 33]);
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "blob", mimeType: "application/octet-stream" }],
          },
          artifacts: [
            {
              partIndex: 0,
              target: "data",
              mimeType: "application/octet-stream",
              bytes,
              sha256: sha256(bytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(inner, workspace, {}, {
      ids: new SequentialIdGenerator(),
      artifactKeyProvider: keys,
    });
    const result = await port.execute(call(), context);
    const reference = firstArtifactReference(result.result);
    activeKey = "new_key";

    const read = await port.execute(
      call("read_offloaded", { handle: reference.handle, encoding: "base64" }),
      context,
    );
    const page = ReadOffloadedResultSchema.parse(read.result);
    expect([...Buffer.from(page.data, "base64")]).toEqual([...bytes]);
    const unavailableReader = new OffloadingToolPort(
      fakePort(null).inner,
      workspace,
      {},
      {
        ids: new SequentialIdGenerator(),
        artifactKeyProvider: keyProvider(
          new Map([["new_key", new Uint8Array(32).fill(2)]]),
        ),
      },
    );
    await expect(
      unavailableReader.execute(
        call("read_offloaded", { handle: reference.handle, encoding: "base64" }),
        context,
      ),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "artifact_decrypt_failed" });
  });

  it("returns a stable unsupported code when replay reads a legacy plaintext artifact", async () => {
    const workspace = new InMemoryWorkspace();
    const handle = "wf_00000000000000000000000000";
    await workspace.write(`.harness/offload/${handle}.bin`, new Uint8Array([1, 2, 3]));
    const port = new OffloadingToolPort(fakePort(null).inner, workspace);

    await expect(
      port.execute(call("read_offloaded", { handle, encoding: "base64" }), context),
    ).resolves.toMatchObject({
      outcome: "error",
      errorCode: "artifact_legacy_unsupported",
    });
  });

  it("checks the substituted envelope limit before atomically writing artifacts", async () => {
    const workspace = new InMemoryWorkspace();
    const writeBatch = vi.spyOn(workspace, "writeBatch");
    const bytes = new Uint8Array([1, 2, 3]);
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "blob", mimeType: "application/octet-stream" }],
          },
          resultLimitBytes: 1,
          artifacts: [
            {
              partIndex: 0,
              target: "data",
              mimeType: "application/octet-stream",
              bytes,
              sha256: sha256(bytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(
      inner,
      workspace,
      {},
      {
        ids: new SequentialIdGenerator(),
        artifactKeyProvider: keyProvider(new Map([["test_key", new Uint8Array(32).fill(7)]])),
      },
    );

    await expect(port.execute(call(), context)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "result_too_large",
      result: null,
    });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("returns only a closed code when a batch artifact write fails", async () => {
    const workspace = new InMemoryWorkspace();
    vi.spyOn(workspace, "writeBatch").mockRejectedValue(new Error("synthetic binary detail"));
    const bytes = new Uint8Array([1, 2, 3]);
    const inner: OffloadToolPortLike = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () =>
        Promise.resolve({
          outcome: "ok",
          result: {
            format: "mcp-tool-result",
            version: 1,
            isError: false,
            parts: [{ type: "image", mimeType: "image/png" }],
          },
          resultLimitBytes: 2_000,
          artifacts: [
            {
              partIndex: 0,
              target: "data",
              mimeType: "image/png",
              bytes,
              sha256: sha256(bytes),
            },
          ],
        }),
    };
    const port = new OffloadingToolPort(
      inner,
      workspace,
      {},
      {
        ids: new SequentialIdGenerator(),
        artifactKeyProvider: keyProvider(new Map([["test_key", new Uint8Array(32).fill(7)]])),
      },
    );

    const execution = await port.execute(call(), context);
    expect(execution).toEqual({
      outcome: "error",
      errorCode: "artifact_write_failed",
      result: null,
    });
    expect(JSON.stringify(execution)).not.toContain("synthetic binary detail");
  });

  it("leaves results at or below the serialized string-length threshold untouched", async () => {
    const workspace = new InMemoryWorkspace();
    const { inner, execution } = fakePort("é");
    const write = vi.spyOn(workspace, "write");
    const port = new OffloadingToolPort(inner, workspace, { thresholdBytes: 3 });

    expect(JSON.stringify(execution.result)).toHaveLength(3);
    expect(new TextEncoder().encode(JSON.stringify(execution.result)).byteLength).toBe(4);
    await expect(port.execute(call(), context)).resolves.toBe(execution);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes oversized results and returns only a validated, bounded stub", async () => {
    const workspace = new InMemoryWorkspace();
    const result = { value: "synthetic-tokenized-output" };
    const serialized = JSON.stringify(result);
    const { inner } = fakePort(result);
    const ids = new SequentialIdGenerator();
    const port = new OffloadingToolPort(
      inner,
      workspace,
      { thresholdBytes: 1, previewChars: 7 },
      { ids },
    );
    const execution = await port.execute(call(), context);
    const stub = OffloadedStub.parse(execution.result);

    expect(stub.$offloaded.handle).toBe("wf_00000000000000000000000000");
    expect(stub.$offloaded.handle).toMatch(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(stub.$offloaded.bytes).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(stub.$offloaded.preview).toBe(serialized.slice(0, 7));
    expect(JSON.stringify(execution)).not.toContain(serialized);
    expect(
      new TextDecoder().decode(
        await workspace.read(`.harness/offload/${stub.$offloaded.handle}.json`),
      ),
    ).toBe(serialized);
  });

  it("keeps an astral character whole at the preview boundary", async () => {
    const serialized = JSON.stringify(`${"a".repeat(8)}😀z`);
    const { inner } = fakePort(`${"a".repeat(8)}😀z`);
    const port = new OffloadingToolPort(
      inner,
      new InMemoryWorkspace(),
      { thresholdBytes: 0, previewChars: 10 },
      { ids: new SequentialIdGenerator() },
    );
    const stub = OffloadedStub.parse((await port.execute(call(), context)).result);

    expect(stub.$offloaded.preview).toBe(Array.from(serialized).slice(0, 10).join(""));
    expect(Array.from(stub.$offloaded.preview)).toHaveLength(10);
    expect(stub.$offloaded.preview.endsWith("😀")).toBe(true);
  });

  it("uses unique ULID handles for separate large results", async () => {
    const workspace = new InMemoryWorkspace();
    const { inner } = fakePort("large");
    const port = new OffloadingToolPort(inner, workspace, { thresholdBytes: 0 });
    const first = OffloadedStub.parse((await port.execute(call(), context)).result);
    const second = OffloadedStub.parse((await port.execute(call(), context)).result);

    expect(first.$offloaded.handle).not.toBe(second.$offloaded.handle);
    expect(first.$offloaded.handle).toMatch(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(second.$offloaded.handle).toMatch(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("retains the inner tool's outcome and error code when offloading its result", async () => {
    const workspace = new InMemoryWorkspace();
    const inner: OffloadToolPortLike = {
      describe: () => undefined,
      execute: () =>
        Promise.resolve({ outcome: "error", errorCode: "tool_failed", result: "large failure" }),
    };
    const port = new OffloadingToolPort(
      inner,
      workspace,
      { thresholdBytes: 0 },
      { ids: new SequentialIdGenerator() },
    );

    const execution = await port.execute(call(), context);
    expect(execution.outcome).toBe("error");
    expect(execution.errorCode).toBe("tool_failed");
    expect(OffloadedStub.safeParse(execution.result).success).toBe(true);
  });

  it("exposes read_offloaded as an idempotent tool and declares its input schema", () => {
    const { inner } = fakePort("small");
    const port = new OffloadingToolPort(inner, new InMemoryWorkspace());

    expect(port.describe("read_offloaded")).toEqual({ idempotent: true, timeoutMs: 30_000 });
    expect(port.describe("sample_tool")).toEqual({ idempotent: false, timeoutMs: 1000 });
    expect(port.describe("missing_tool")).toBeUndefined();
    expect(READ_OFFLOADED_TOOL_SPEC.toolId).toBe("read_offloaded");
    expect(port.getToolSpecs()).toContainEqual(READ_OFFLOADED_TOOL_SPEC);
    expect(
      ReadOffloadedInputSchema.safeParse({ handle: "wf_00000000000000000000000000" }).success,
    ).toBe(true);
  });

  it("pages through the entire stored result with a 16 KiB maximum per read", async () => {
    const workspace = new InMemoryWorkspace();
    const serialized = JSON.stringify("é".repeat(40_000));
    const { inner, execute } = fakePort("é".repeat(40_000));
    const port = new OffloadingToolPort(inner, workspace, { thresholdBytes: 0 });
    const stub = OffloadedStub.parse((await port.execute(call(), context)).result);
    const first = await port.execute(
      call("read_offloaded", { handle: stub.$offloaded.handle, length: 100_000 }),
      context,
    );
    expect(first.outcome).toBe("ok");
    const pages = [ReadOffloadedResultSchema.parse(first.result)];
    let offset = pages[0]?.nextOffset;
    while (offset !== undefined) {
      const page = await port.execute(
        call("read_offloaded", { handle: stub.$offloaded.handle, offset }),
        context,
      );
      pages.push(ReadOffloadedResultSchema.parse(page.result));
      offset = pages.at(-1)?.nextOffset;
    }

    expect(pages.map(({ data }) => data).join("")).toBe(serialized);
    expect(pages.every(({ data }) => new TextEncoder().encode(data).byteLength <= 16 * 1024)).toBe(
      true,
    );
    expect(pages.every(({ totalBytes }) => totalBytes === stub.$offloaded.bytes)).toBe(true);
    expect(pages[0]?.nextOffset).toBe(16 * 1024 - 1);
    expect(execute).toHaveBeenCalledTimes(1);

    const firstCharacter = await port.execute(
      call("read_offloaded", { handle: stub.$offloaded.handle, length: 2 }),
      context,
    );
    expect(ReadOffloadedResultSchema.parse(firstCharacter.result)).toMatchObject({
      data: '"é',
      nextOffset: 3,
    });
    await expect(
      port.execute(call("read_offloaded", { handle: stub.$offloaded.handle, offset: 2 }), context),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "invalid_offset" });
  });

  it("returns handle_not_found for unknown and invalid handles", async () => {
    const port = new OffloadingToolPort(fakePort(null).inner, new InMemoryWorkspace());
    const unknown = await port.execute(
      call("read_offloaded", { handle: "wf_00000000000000000000000000" }),
      context,
    );
    const invalid = await port.execute(call("read_offloaded", { handle: "../../secret" }), context);
    const trailingNewline = await port.execute(
      call("read_offloaded", { handle: "wf_00000000000000000000000000\n" }),
      context,
    );

    expect(unknown).toMatchObject({
      outcome: "error",
      errorCode: "handle_not_found",
      result: null,
    });
    expect(invalid).toMatchObject({
      outcome: "error",
      errorCode: "invalid_arguments",
      result: null,
    });
    expect(trailingNewline).toMatchObject({
      outcome: "error",
      errorCode: "invalid_arguments",
      result: null,
    });
  });

  it("keeps four-byte UTF-8 characters within the 16 KiB page cap", async () => {
    const workspace = new InMemoryWorkspace();
    const result = "😀".repeat(10_000);
    const serialized = JSON.stringify(result);
    const port = new OffloadingToolPort(fakePort(result).inner, workspace, { thresholdBytes: 0 });
    const stub = OffloadedStub.parse((await port.execute(call(), context)).result);
    const first = await port.execute(
      call("read_offloaded", { handle: stub.$offloaded.handle, length: 16 * 1024 - 1 }),
      context,
    );
    const firstPage = ReadOffloadedResultSchema.parse(first.result);
    const pages = [firstPage];
    let offset = firstPage.nextOffset;
    while (offset !== undefined) {
      const next = await port.execute(
        call("read_offloaded", { handle: stub.$offloaded.handle, offset }),
        context,
      );
      pages.push(ReadOffloadedResultSchema.parse(next.result));
      offset = pages.at(-1)?.nextOffset;
    }

    expect(firstPage.data).toBe(`"${"😀".repeat(4095)}`);
    expect(new TextEncoder().encode(firstPage.data).byteLength).toBe(16 * 1024 - 3);
    expect(pages.every(({ data }) => new TextEncoder().encode(data).byteLength <= 16 * 1024)).toBe(
      true,
    );
    expect(pages.map(({ data }) => data).join("")).toBe(serialized);
  });

  it("pages persisted files with bounded reads after constructing a new decorator", async () => {
    const workspace = new InMemoryWorkspace();
    const handle = "wf_00000000000000000000000000";
    const serialized = JSON.stringify("saved".repeat(10_000));
    await workspace.write(`.harness/offload/${handle}.json`, new TextEncoder().encode(serialized));
    const read = vi.spyOn(workspace, "read");
    const port = new OffloadingToolPort(fakePort(null).inner, workspace);
    const first = await port.execute(call("read_offloaded", { handle }), context);
    const firstPage = ReadOffloadedResultSchema.parse(first.result);

    expect(first.outcome).toBe("ok");
    expect(firstPage.data).toBe(serialized.slice(0, 16 * 1024));
    expect(firstPage.totalBytes).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(read.mock.calls.length).toBeGreaterThan(2);
    expect(
      read.mock.calls.every(([, range]) => range !== undefined && range.length <= 16 * 1024),
    ).toBe(true);

    const readsAfterFirstPage = read.mock.calls.length;
    const second = await port.execute(
      call("read_offloaded", { handle, offset: 16 * 1024 }),
      context,
    );
    expect(ReadOffloadedResultSchema.parse(second.result).data).toBe(
      serialized.slice(16 * 1024, 32 * 1024),
    );
    expect(read.mock.calls).toHaveLength(readsAfterFirstPage + 1);
  });

  it("does not offload the paging tool's own response", async () => {
    const workspace = new InMemoryWorkspace();
    const port = new OffloadingToolPort(fakePort("large").inner, workspace, { thresholdBytes: 0 });
    const execution = await port.execute(
      call("read_offloaded", { handle: "wf_00000000000000000000000000" }),
      context,
    );

    expect(execution.result).toBeNull();
    await expect(workspace.read(".harness/offload/unused.json")).rejects.toBeInstanceOf(
      WorkspaceFileNotFoundError,
    );
  });

  it("propagates workspace errors other than a missing file", async () => {
    const workspace: WorkspacePort = {
      write: () => Promise.resolve(),
      writeBatch: () => Promise.resolve(),
      read: () => Promise.reject(new Error("synthetic workspace failure")),
    };
    const port = new OffloadingToolPort(fakePort(null).inner, workspace);

    await expect(
      port.execute(call("read_offloaded", { handle: "wf_00000000000000000000000000" }), context),
    ).rejects.toThrow("synthetic workspace failure");
  });
});

describe("NaiveStrategy offload stats", () => {
  it("counts only schema-valid offload stubs in tool results", async () => {
    const offloadedHandle = "wf_00000000000000000000000000";
    const events: Event[] = [
      {
        runId,
        seq: 0,
        ts: 0,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: "22222222222222222222222222",
        type: "run_input",
        input: "inspect results",
        inputKind: "initial",
      },
      {
        runId,
        seq: 1,
        ts: 1,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: "22222222222222222222222222",
        type: "model_response",
        requestId: "33333333333333333333333333",
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        latencyMs: 0,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [
          { type: "tool_call", callId, toolId: "sample_tool", args: {} },
          {
            type: "tool_call",
            callId: Id.parse("44444444444444444444444444"),
            toolId: "sample_tool",
            args: {},
          },
        ],
        providerBlobs: null,
      },
      toolResult(2, { $offloaded: { handle: offloadedHandle, bytes: 20, preview: "data" } }),
      toolResult(
        3,
        { $offloaded: { handle: offloadedHandle, bytes: -1, preview: "invalid" } },
        Id.parse("44444444444444444444444444"),
      ),
    ];

    const result = await new NaiveStrategy().build({
      events,
      budget: { maxTokens: 1000, reserveOutputTokens: 10 },
      model: { provider: "test", model: "test" },
      counter: { count: () => 10 },
    });

    expect(result.stats.offloadedResults).toBe(1);
  });
});
