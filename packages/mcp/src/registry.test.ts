// SPDX-License-Identifier: Apache-2.0
import { ServerConfigSchema } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  ToolRegistryError,
  UNREGISTERED_TOOL_ID,
  normalizeToolId,
} from "./registry.js";
import type { McpTool } from "./tool-list.js";

const inputSchema: McpTool["inputSchema"] = { type: "object", properties: {} };

function config(
  id: string,
  options: {
    readonly toolPrefix?: string;
    readonly toolAllowlist?: string[];
    readonly idempotentTools?: string[];
    readonly trust?: "internal" | "external";
    readonly useAnnotations?: boolean;
    readonly callMs?: number;
  } = {},
) {
  return ServerConfigSchema.parse({
    id,
    toolPrefix: options.toolPrefix,
    toolAllowlist: options.toolAllowlist,
    idempotentTools: options.idempotentTools,
    trust: options.trust,
    useAnnotations: options.useAnnotations,
    transport: { kind: "stdio", command: "/bin/false" },
    timeouts: { callMs: options.callMs ?? 4_000 },
  });
}

function tool(
  name: string,
  options: {
    readonly description?: string;
    readonly inputSchema?: McpTool["inputSchema"];
    readonly outputSchema?: McpTool["outputSchema"];
    readonly annotations?: McpTool["annotations"];
  } = {},
): McpTool {
  return {
    name,
    inputSchema: options.inputSchema ?? inputSchema,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
  };
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("normalizeToolId", () => {
  it.each([
    ["UPPER_CASE", "server.upper_case"],
    ["Read Tool", "server.read_tool"],
    ["sch\u00f6n", "server.sch_n"],
    ["one___two", "server.one_two"],
  ])("normalizes %s", (nativeName, expected) => {
    expect(normalizeToolId("server", nativeName)).toBe(expected);
  });

  it("truncates long names to the Code limit with a stable hash suffix", () => {
    const first = normalizeToolId("server", `x${"a".repeat(90)}first`);
    const second = normalizeToolId("server", `x${"a".repeat(90)}second`);

    expect(first).toMatch(/^[a-z0-9_.-]{57}-[0-9a-f]{6}$/u);
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  it.each([[`${"a".repeat(70)}\u00f6`, `${"a".repeat(70)}\u00fc`]])(
    "keeps long names distinct when replaced Unicode characters differ",
    (firstName, secondName) => {
      const first = normalizeToolId("server", firstName);
      const second = normalizeToolId("server", secondName);

      expect(first).toHaveLength(64);
      expect(second).toHaveLength(64);
      expect(first).not.toBe(second);
    },
  );
});

describe("ToolRegistry", () => {
  it("keeps allowed tools in discovery order and reports excluded native names", () => {
    const registry = new ToolRegistry([
      {
        config: config("server", { toolAllowlist: ["allowed"] }),
        tools: [tool("excluded"), tool("allowed", { outputSchema: { type: "object" } })],
      },
    ]);

    expect(registry.getToolSpecs().map(({ toolId }) => toolId)).toEqual(["server.allowed"]);
    expect(registry.resolve("server.allowed")?.outputSchema).toEqual({ type: "object" });
    expect(registry.resolve("unknown.tool")).toBeUndefined();
    expect(registry.rejected()).toEqual([
      { serverId: "server", nativeName: "excluded", reason: "tool_not_allowlisted" },
    ]);
  });

  it("fails startup with both server ids when normalized ids collide", () => {
    const build = () =>
      new ToolRegistry([
        { config: config("first", { toolPrefix: "shared" }), tools: [tool("A B")] },
        { config: config("second", { toolPrefix: "shared" }), tools: [tool("a_b")] },
      ]);
    const error = thrownBy(build);

    expect(error).toBeInstanceOf(ToolRegistryError);
    expect(error).toMatchObject({
      code: "tool_id_collision",
      serverIds: ["first", "second"],
      normalizedToolId: "shared.a_b",
    });
  });

  it("fails startup when tools on the same server normalize to the same id", () => {
    const error = thrownBy(
      () =>
        new ToolRegistry([
          { config: config("server"), tools: [tool("Get Data"), tool("get_data")] },
        ]),
    );

    expect(error).toMatchObject({
      code: "tool_id_collision",
      serverIds: ["server", "server"],
      normalizedToolId: "server.get_data",
    });
  });

  it("rejects schemas over 64 KiB and unsupported remote references", () => {
    const registry = new ToolRegistry([
      {
        config: config("server"),
        tools: [
          tool("large", {
            inputSchema: { type: "object", description: "x".repeat(65 * 1024) },
          }),
          tool("remote", {
            inputSchema: { type: "object", $ref: "https://schemas.invalid/tool.json" },
          }),
        ],
      },
    ]);

    expect(registry.getToolSpecs()).toEqual([]);
    expect(registry.rejected()).toEqual([
      { serverId: "server", nativeName: "large", reason: "tool_schema_too_large" },
      { serverId: "server", nativeName: "remote", reason: "tool_schema_unsupported" },
    ]);
  });

  it("rejects oversized output schemas as well as oversized input schemas", () => {
    const registry = new ToolRegistry([
      {
        config: config("server"),
        tools: [
          tool("large_output", {
            outputSchema: { type: "object", description: "x".repeat(65 * 1024) },
          }),
        ],
      },
    ]);

    expect(registry.rejected()).toEqual([
      { serverId: "server", nativeName: "large_output", reason: "tool_schema_too_large" },
    ]);
  });

  it("sanitizes server descriptions before exposing model-visible specs", () => {
    const registry = new ToolRegistry([
      {
        config: config("server"),
        tools: [tool("description", { description: "  Read\u0000 \n this\t tool  " })],
      },
    ]);

    expect(registry.getToolSpecs()[0]?.description).toBe("Read this tool");
    expect(
      new ToolRegistry([
        {
          config: config("server"),
          tools: [tool("long_description", { description: "x".repeat(1_100) })],
        },
      ]).getToolSpecs()[0]?.description,
    ).toHaveLength(1_024);
  });

  it("uses explicit idempotency and only trusts annotations when configured for an internal server", () => {
    const annotation = { idempotentHint: true };
    const registry = new ToolRegistry([
      {
        config: config("internal", { trust: "internal", useAnnotations: true, callMs: 123 }),
        tools: [
          tool("annotated", { annotations: annotation }),
          tool("read_only", {
            annotations: { readOnlyHint: true },
          }),
        ],
      },
      {
        config: config("external", { trust: "external" }),
        tools: [tool("annotated", { annotations: annotation })],
      },
      {
        config: config("configured", { idempotentTools: ["explicit"] }),
        tools: [tool("explicit")],
      },
    ]);

    expect(registry.describe("internal.annotated")).toMatchObject({
      idempotent: true,
      timeoutMs: 123,
    });
    expect(registry.describe("internal.read_only")?.idempotent).toBe(true);
    expect(registry.describe("external.annotated")?.idempotent).toBe(false);
    expect(registry.describe("configured.explicit")?.idempotent).toBe(true);
    expect(registry.describe("missing.tool")).toBeUndefined();
  });

  it("rejects empty native names and exposes the unknown-tool sentinel", () => {
    const registry = new ToolRegistry([{ config: config("server"), tools: [tool("")] }]);

    expect(UNREGISTERED_TOOL_ID).toBe("unregistered_tool");
    expect(registry.describe(UNREGISTERED_TOOL_ID)).toBeUndefined();
    expect(registry.rejected()).toEqual([
      { serverId: "server", nativeName: "", reason: "tool_name_invalid" },
    ]);
  });
});
