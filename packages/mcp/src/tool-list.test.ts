// SPDX-License-Identifier: Apache-2.0
import { type ListToolsResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, decodedBytes, DiscoveryTask } from "./discovery-budget.js";
import { listAllTools, type ListAllToolsOptions, type McpTool } from "./tool-list.js";

const tool: McpTool = { name: "synthetic", inputSchema: { type: "object" } };
const invalidTool: McpTool = {
  ...tool,
  inputSchema: { type: "object", properties: { secret: { "x-mcp-header": "baggage" } } },
};

function discover(requestPage: ListAllToolsOptions["requestPage"], signal?: AbortSignal) {
  return listAllTools({
    requestPage,
    era: "modern",
    transport: "http",
    onExcluded: () => undefined,
    ...(signal === undefined ? {} : { signal }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded tool discovery", () => {
  it.each([{ tools: [] }, { tools: [tool] }, { tools: [invalidTool] }])(
    "bounds unique cursors even with empty or rejected pages: %j",
    async ({ tools }) => {
      const request = vi.fn(() =>
        Promise.resolve({ tools, nextCursor: String(request.mock.calls.length) }),
      );
      await expect(discover(request)).rejects.toMatchObject({
        code: "mcp_discovery_page_limit",
        message: "mcp_discovery_page_limit",
      });
      expect(request).toHaveBeenCalledTimes(100);
    },
  );

  it("accepts exactly 100 pages and follows empty-page continuations", async () => {
    let pages = 0;
    const request = vi.fn(() => {
      pages++;
      return Promise.resolve({
        tools: pages === 100 ? [tool] : [],
        ...(pages === 100 ? {} : { nextCursor: String(pages) }),
        ttlMs: 42,
      });
    });
    await expect(discover(request)).resolves.toEqual({ tools: [tool], ttlMs: 42 });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it("rejects repeated cursors, including on empty pages", async () => {
    const request = vi.fn(() => Promise.resolve({ tools: [], nextCursor: "synthetic-cursor" }));
    await expect(discover(request)).rejects.toMatchObject({ code: "mcp_list_tools_failed" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([tool, invalidTool])("counts observed rather than retained tools: %j", async (item) => {
    const request = vi.fn(() =>
      Promise.resolve({ tools: Array.from({ length: 1_001 }, () => item) }),
    );
    await expect(discover(request)).rejects.toMatchObject({ code: "mcp_too_many_tools" });
  });

  it("counts rejected tools cumulatively across pages", async () => {
    let pages = 0;
    const request = vi.fn(() => {
      pages++;
      return Promise.resolve({
        tools: Array.from({ length: 501 }, () => invalidTool),
        nextCursor: String(pages),
      });
    });
    await expect(discover(request)).rejects.toMatchObject({ code: "mcp_too_many_tools" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly 1,000 observed tools", async () => {
    await expect(
      discover(() => Promise.resolve({ tools: Array.from({ length: 1_000 }, () => tool) })),
    ).resolves.toMatchObject({ tools: { length: 1_000 } });
  });

  it.each(["inputSchema", "outputSchema"] as const)("bounds %s before filtering", async (key) => {
    const oversized = { type: "object" as const, description: "x".repeat(1_048_576) };
    await expect(
      discover(() => Promise.resolve({ tools: [{ ...invalidTool, [key]: oversized }] })),
    ).rejects.toMatchObject({ code: "mcp_discovery_schema_limit" });
  });

  it("accepts exactly 1 MiB per schema, rejects one more byte", async () => {
    const base = { type: "object" as const, description: "" };
    const length = 1_048_576 - Buffer.byteLength(JSON.stringify(base));
    const inputSchema = { ...base, description: "x".repeat(length) };
    await expect(
      discover(() => Promise.resolve({ tools: [{ ...tool, inputSchema }] })),
    ).resolves.toMatchObject({
      tools: { length: 1 },
    });
    inputSchema.description += "x";
    await expect(
      discover(() => Promise.resolve({ tools: [{ ...tool, inputSchema }] })),
    ).rejects.toMatchObject({
      code: "mcp_discovery_schema_limit",
    });
  });

  it("bounds aggregate decoded data across pages, including descriptions", async () => {
    let pages = 0;
    const request = vi.fn(() => {
      pages++;
      return Promise.resolve({
        tools: [{ ...tool, description: "x".repeat(1_048_576) }],
        nextCursor: String(pages),
      });
    });
    await expect(discover(request)).rejects.toMatchObject({ code: "mcp_discovery_data_limit" });
    expect(request).toHaveBeenCalledTimes(8);
  });

  it("accepts exactly 8 MiB decoded data and rejects one more byte", async () => {
    const page = { tools: [{ ...tool, description: "" }] };
    page.tools[0] = {
      ...tool,
      description: "x".repeat(8_388_608 - Buffer.byteLength(JSON.stringify(page))),
    };
    await expect(discover(() => Promise.resolve(page))).resolves.toMatchObject({
      tools: { length: 1 },
    });
    page.tools[0].description += "x";
    await expect(discover(() => Promise.resolve(page))).rejects.toMatchObject({
      code: "mcp_discovery_data_limit",
    });
  });

  it("uses one deadline across pages and aborts the outstanding request", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((_cursor: string | undefined, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<ListToolsResult>((resolve) => {
        setTimeout(() => {
          resolve({ tools: [tool], nextCursor: String(request.mock.calls.length) });
        }, 20_000);
      });
    });
    const result = discover(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ code: "mcp_discovery_timeout" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("cancels stalled work, rejects pre-aborted calls, and releases concurrency slots", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<ListToolsResult>(() => undefined));
    const result = discover(request, controller.signal).catch((error: unknown) => error);
    controller.abort(new Error("synthetic-private-content"));
    expect(await result).toMatchObject({ code: "mcp_discovery_cancelled" });
    await expect(discover(request, controller.signal)).rejects.toMatchObject({
      code: "mcp_discovery_cancelled",
      message: "mcp_discovery_cancelled",
    });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(discover(() => Promise.resolve({ tools: [] }))).resolves.toMatchObject({
      tools: [],
    });
  });

  it("allows four discoveries and rejects a fifth without starting it", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<ListToolsResult>(() => undefined));
    const running = Array.from({ length: 4 }, async () => {
      await expect(discover(request, controller.signal)).rejects.toMatchObject({
        code: "mcp_discovery_cancelled",
      });
    });
    try {
      await expect(discover(request)).rejects.toMatchObject({ code: "mcp_discovery_busy" });
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      controller.abort();
      await Promise.all(running);
    }
    await expect(discover(() => Promise.resolve({ tools: [] }))).resolves.toMatchObject({
      tools: [],
    });
  });

  it("returns only code-based errors for malicious request failures", async () => {
    await expect(
      discover(() => Promise.reject(new Error("synthetic-private-content"))),
    ).rejects.toMatchObject({
      code: "mcp_list_tools_failed",
      message: "mcp_list_tools_failed",
    });
  });

  it("checks elapsed time after synchronous decoded work, not only timer callbacks", async () => {
    let now = 0;
    await expect(
      listAllTools({
        requestPage: () => {
          now = 30_000;
          return Promise.resolve({ tools: [tool] });
        },
        era: "legacy",
        transport: "stdio",
        now: () => now,
        onExcluded: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "mcp_discovery_timeout" });
  });

  describe("shared discovery task", () => {
    it("rejects pre-aborted participants without starting work", async () => {
      const task = new DiscoveryTask<number>();
      const operation = vi.fn(() => Promise.resolve(1));
      await expect(task.run(operation, AbortSignal.abort())).rejects.toMatchObject({
        code: "mcp_discovery_cancelled",
      });
      expect(operation).not.toHaveBeenCalled();
    });

    it("allows a joining caller to cancel shared work and permits the next refresh", async () => {
      const task = new DiscoveryTask<number>();
      const operation = vi.fn((signal: AbortSignal) =>
        abortable(() => new Promise<number>(() => undefined), signal),
      );
      const first = task.run(operation).catch((error: unknown) => error);
      const controller = new AbortController();
      const joined = task.run(operation, controller.signal).catch((error: unknown) => error);
      controller.abort();
      expect(await first).toMatchObject({ code: "mcp_discovery_cancelled" });
      expect(await joined).toMatchObject({ code: "mcp_discovery_cancelled" });
      expect(operation).toHaveBeenCalledTimes(1);
      await expect(task.run(() => Promise.resolve(2))).resolves.toBe(2);
      task.cancel();
    });
  });
});

describe("decoded-data measurement", () => {
  it.each([null, true, 123, "é😀\n", {}, [], { a: [1, { b: "é" }], c: null }])(
    "matches compact JSON UTF-8 bytes: %j",
    (value) => {
      const signal = new AbortController().signal;
      const size = Buffer.byteLength(JSON.stringify(value));
      expect(decodedBytes(value, size, "mcp_discovery_data_limit", signal)).toBe(size);
      expect(() => decodedBytes(value, size - 1, "mcp_discovery_data_limit", signal)).toThrow(
        "mcp_discovery_data_limit",
      );
    },
  );

  it("rejects undefined, excessive primitive sizes, cycles, and already-cancelled work", async () => {
    const signal = new AbortController().signal;
    for (const value of [undefined, "x".repeat(100)]) {
      expect(() => decodedBytes(value, 10, "mcp_discovery_data_limit", signal)).toThrow(
        "mcp_discovery_data_limit",
      );
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => decodedBytes(cyclic, 100, "mcp_discovery_data_limit", signal)).toThrow(
      "mcp_discovery_data_limit",
    );
    expect(() => decodedBytes({}, 10, "mcp_discovery_data_limit", AbortSignal.abort())).toThrow(
      "mcp_discovery_cancelled",
    );
    await expect(abortable(() => Promise.resolve(1), AbortSignal.abort())).rejects.toMatchObject({
      code: "mcp_discovery_cancelled",
    });
  });
});
