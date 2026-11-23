// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { McpPromptGrantsSchema, McpPromptSelectionsSchema } from "./mcp-prompts.js";

describe("MCP prompt contracts", () => {
  it("accepts bounded selections with string arguments", () => {
    expect(
      McpPromptSelectionsSchema.parse([
        { serverId: "docs", name: "summarize", arguments: { topic: "safe synthetic value" } },
      ]),
    ).toHaveLength(1);
  });

  it("rejects more than sixteen selections", () => {
    const selections = Array.from({ length: 17 }, (_, index) => ({
      serverId: "docs",
      name: `prompt-${String(index)}`,
    }));

    expect(McpPromptSelectionsSchema.safeParse(selections).success).toBe(false);
  });

  it("rejects non-string, excessive, and over-sized arguments", () => {
    expect(
      McpPromptSelectionsSchema.safeParse([
        { serverId: "docs", name: "summarize", arguments: { topic: 42 } },
      ]).success,
    ).toBe(false);
    expect(
      McpPromptSelectionsSchema.safeParse([
        {
          serverId: "docs",
          name: "summarize",
          arguments: { topic: "x".repeat(8_193) },
        },
      ]).success,
    ).toBe(false);
    expect(
      McpPromptSelectionsSchema.safeParse([
        {
          serverId: "docs",
          name: "summarize",
          arguments: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`a${String(index)}`, "x"]),
          ),
        },
      ]).success,
    ).toBe(false);
  });

  it("applies UTF-8 limits to names and aggregate arguments", () => {
    expect(
      McpPromptSelectionsSchema.safeParse([
        {
          serverId: "docs",
          name: "summarize",
          arguments: { ["é".repeat(65)]: "x" },
        },
      ]).success,
    ).toBe(false);
    expect(
      McpPromptSelectionsSchema.safeParse([
        {
          serverId: "docs",
          name: "summarize",
          arguments: Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [
              `argument${String(index)}`,
              "x".repeat(1_024),
            ]),
          ),
        },
      ]).success,
    ).toBe(false);
  });

  it("rejects duplicate grants and accepts empty grants", () => {
    expect(McpPromptGrantsSchema.safeParse(["summarize", "summarize"]).success).toBe(false);
    expect(McpPromptGrantsSchema.parse([])).toEqual([]);
  });
});
