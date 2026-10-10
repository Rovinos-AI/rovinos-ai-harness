// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import type { Message } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { prepareMessagesForProvider } from "./blobs.js";

const callId = Id.parse("00000000000000000000000001");

describe("prepareMessagesForProvider", () => {
  it("keeps a matching provider blob with normalized assistant parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "opaque", provider: "anthropic", blob: { signature: "synthetic" } },
        ],
      },
    ];

    expect(prepareMessagesForProvider(messages, "anthropic")).toEqual(messages);
    expect(messages[0]?.parts).toHaveLength(2);
  });

  it("drops a mismatched blob and retains normalized assistant parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "tool_call", callId, toolId: "lookup", args: { key: "value" } },
          { type: "opaque", provider: "anthropic", blob: { signature: "synthetic" } },
        ],
      },
    ];

    expect(prepareMessagesForProvider(messages, "openai")).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "tool_call", callId, toolId: "lookup", args: { key: "value" } },
        ],
      },
    ]);
  });

  it("filters mixed provider blobs and preserves tool-result call ids", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "opaque", provider: "anthropic", blob: { blocks: ["thinking"] } },
          { type: "opaque", provider: "openai", blob: { message: { content: "answer" } } },
        ],
      },
      {
        role: "tool",
        parts: [
          { type: "tool_result", callId, result: { found: true }, isError: false },
          { type: "opaque", provider: "anthropic", blob: { ignored: true } },
        ],
      },
    ];

    expect(prepareMessagesForProvider(messages, "openai")).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "answer" },
          { type: "opaque", provider: "openai", blob: { message: { content: "answer" } } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_result", callId, result: { found: true }, isError: false }],
      },
    ]);
  });
});
