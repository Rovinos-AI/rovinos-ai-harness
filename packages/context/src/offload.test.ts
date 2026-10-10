// SPDX-License-Identifier: Apache-2.0
import { Id, SequentialIdGenerator, type Event, type JsonValue } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
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
  it("leaves results at or below the UTF-8 byte threshold untouched", async () => {
    const workspace = new InMemoryWorkspace();
    const { inner, execution } = fakePort("é");
    const write = vi.spyOn(workspace, "write");
    const port = new OffloadingToolPort(inner, workspace, { thresholdBytes: 4 });

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
      ids,
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
      new SequentialIdGenerator(),
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

  it("can read an existing handle after constructing a new decorator", async () => {
    const workspace = new InMemoryWorkspace();
    const handle = "wf_00000000000000000000000000";
    await workspace.write(`.harness/offload/${handle}.json`, new TextEncoder().encode("saved"));
    const port = new OffloadingToolPort(fakePort(null).inner, workspace);

    await expect(port.execute(call("read_offloaded", { handle }), context)).resolves.toMatchObject({
      outcome: "ok",
      result: { data: "saved", totalBytes: 5 },
    });
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
