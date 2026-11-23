// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { listAllPrompts } from "./prompts.js";
import { McpConnectionError } from "./errors.js";

describe("listAllPrompts", () => {
  it("follows prompt cursors and returns the complete catalog", async () => {
    const cursors: (string | undefined)[] = [];
    const prompts = await listAllPrompts({
      requestPage: (cursor) => {
        cursors.push(cursor);
        return Promise.resolve(
          cursor === undefined
            ? { prompts: [{ name: "first" }], nextCursor: "next" }
            : { prompts: [{ name: "second" }] },
        );
      },
    });

    expect(cursors).toEqual([undefined, "next"]);
    expect(prompts.map(({ name }) => name)).toEqual(["first", "second"]);
  });

  it("fails closed when the catalog exceeds the prompt-count limit", async () => {
    await expect(
      listAllPrompts({
        requestPage: () =>
          Promise.resolve({
            prompts: Array.from({ length: 1_001 }, (_, index) => ({
              name: `prompt-${String(index)}`,
            })),
          }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("fails closed when decoded catalog data exceeds eight MiB", async () => {
    await expect(
      listAllPrompts({
        requestPage: () =>
          Promise.resolve({
            prompts: [{ name: "prompt", description: "x".repeat(8_388_609) }],
          }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("rejects repeated pagination cursors", async () => {
    await expect(
      listAllPrompts({
        requestPage: (cursor) =>
          Promise.resolve({
            prompts: [],
            nextCursor: cursor ?? "repeated",
          }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_failed" });
  });

  it("fails closed when discovery exceeds the page limit", async () => {
    await expect(
      listAllPrompts({
        requestPage: (cursor) =>
          Promise.resolve({
            prompts: [],
            nextCursor: String(Number(cursor ?? "0") + 1),
          }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("rejects duplicate prompt names across pages", async () => {
    await expect(
      listAllPrompts({
        requestPage: (cursor) =>
          Promise.resolve({
            prompts: [{ name: "same" }],
            ...(cursor === undefined ? { nextCursor: "next" } : {}),
          }),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_failed" });
  });

  it("maps wire-level oversized responses to the prompt size error", async () => {
    await expect(
      listAllPrompts({
        requestPage: () => Promise.reject(new McpConnectionError("mcp_response_too_large")),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_result_too_large" });
  });

  it("rejects discovery requested with an already-aborted signal", async () => {
    await expect(
      listAllPrompts({
        requestPage: () => Promise.resolve({ prompts: [] }),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "mcp_prompt_failed" });
  });
});
