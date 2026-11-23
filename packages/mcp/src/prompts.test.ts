// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { listAllPrompts } from "./prompts.js";

describe("listAllPrompts", () => {
  it("follows prompt cursors and returns the complete catalog", async () => {
    const cursors: (string | undefined)[] = [];
    const prompts = await listAllPrompts({
      requestPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === undefined
          ? { prompts: [{ name: "first" }], nextCursor: "next" }
          : { prompts: [{ name: "second" }] };
      },
    });

    expect(cursors).toEqual([undefined, "next"]);
    expect(prompts.map(({ name }) => name)).toEqual(["first", "second"]);
  });

  it("fails closed when the catalog exceeds the prompt-count limit", async () => {
    await expect(
      listAllPrompts({
        requestPage: async () => ({
          prompts: Array.from({ length: 1_001 }, (_, index) => ({ name: `prompt-${index}` })),
        }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("fails closed when decoded catalog data exceeds eight MiB", async () => {
    await expect(
      listAllPrompts({
        requestPage: async () => ({
          prompts: [{ name: "prompt", description: "x".repeat(8_388_609) }],
        }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("rejects repeated pagination cursors", async () => {
    await expect(
      listAllPrompts({
        requestPage: async (cursor) => ({
          prompts: [],
          nextCursor: cursor ?? "repeated",
        }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_failed" });
  });
});
