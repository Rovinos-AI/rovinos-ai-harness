// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { InMemoryVault } from "@rovinos/vault";
import { Id, PiiPolicySchema } from "@rovinos/schemas";
import { Tokenizer } from "@rovinos/pii";
import { McpPromptError } from "@rovinos/mcp";
import { createMcpPromptTokenizer } from "./prompt-tokenization.js";

function tokenizer(): Tokenizer {
  return new Tokenizer({
    detectors: { detect: () => [] },
    policy: PiiPolicySchema.parse({ defaultAction: "tokenize" }),
    vault: new InMemoryVault(),
  });
}

describe("createMcpPromptTokenizer", () => {
  it("tokenizes prompt content at the hosted model-input boundary", async () => {
    const piiTokenizer = tokenizer();
    const tokenizeText = vi.spyOn(piiTokenizer, "tokenizeText");
    const runId = Id.parse("A".repeat(26));

    await expect(
      createMcpPromptTokenizer(piiTokenizer)(runId, "prompt content", new AbortController().signal),
    ).resolves.toBe("prompt content");
    expect(tokenizeText).toHaveBeenCalledWith(runId, "prompt content", {
      boundary: "model_input",
      destination: "hosted",
    });
  });

  it("maps tokenizer failures to a closed prompt error", async () => {
    const piiTokenizer = tokenizer();
    vi.spyOn(piiTokenizer, "tokenizeText").mockRejectedValue(new Error("synthetic failure"));

    await expect(
      createMcpPromptTokenizer(piiTokenizer)(
        Id.parse("A".repeat(26)),
        "content",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "mcp_prompt_failed" });
  });

  it("rejects an already-aborted request before tokenization", async () => {
    const piiTokenizer = tokenizer();
    const tokenizeText = vi.spyOn(piiTokenizer, "tokenizeText");
    const controller = new AbortController();
    controller.abort();

    await expect(
      createMcpPromptTokenizer(piiTokenizer)(
        Id.parse("A".repeat(26)),
        "content",
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(McpPromptError);
    expect(tokenizeText).not.toHaveBeenCalled();
  });

  it("rejects if cancellation occurs while tokenization is running", async () => {
    const piiTokenizer = tokenizer();
    vi.spyOn(piiTokenizer, "tokenizeText").mockResolvedValue({ text: "safe", actions: [] });
    const controller = new AbortController();
    const tokenize = createMcpPromptTokenizer(piiTokenizer)(
      Id.parse("A".repeat(26)),
      "content",
      controller.signal,
    );
    controller.abort();

    await expect(tokenize).rejects.toBeInstanceOf(McpPromptError);
  });
});
