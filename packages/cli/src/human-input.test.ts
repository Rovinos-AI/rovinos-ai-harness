// SPDX-License-Identifier: Apache-2.0
import { Code, Id, type InputRequest } from "@rovinos/schemas";
import { describe, expect, it, vi } from "vitest";
import type { Interactive } from "./command.js";
import { createOutput } from "./output.js";
import { createTerminalInputChannel, promptForInput } from "./human-input.js";

const requestId = Id.parse("A".repeat(26));

function formRequest(schema?: InputRequest["schema"]): InputRequest {
  return {
    requestId,
    source: "agent",
    round: 1,
    mode: "form",
    message: "Synthetic prompt",
    ...(schema === undefined ? {} : { schema }),
  };
}

function output() {
  const written: string[] = [];
  return {
    written,
    out: createOutput({ stdout: (text) => written.push(text), stderr: () => undefined }),
  };
}

describe("human input prompts", () => {
  it("uses schema defaults and accepts a JSON value when no schema is supplied", async () => {
    const formPrompt = vi.fn<NonNullable<Interactive["prompt"]>>().mockResolvedValue("");
    const formOutput = output();
    const formAnswer = await promptForInput(
      formRequest({
        type: "object",
        properties: {
          name: { type: "string", default: "Ada" },
          note: { type: "string" },
        },
        required: ["name"],
      }),
      {
        interactive: {
          isTTY: true,
          prompt: formPrompt,
          confirm: vi.fn().mockResolvedValue(true),
        },
        out: formOutput.out,
      },
    );
    expect(formAnswer).toEqual({ action: "accept", answer: { name: "Ada" } });

    const valuePrompt = vi.fn<NonNullable<Interactive["prompt"]>>().mockResolvedValue("42");
    const valueAnswer = await promptForInput(formRequest(), {
      interactive: {
        isTTY: true,
        prompt: valuePrompt,
        confirm: vi.fn().mockResolvedValue(true),
      },
      out: formOutput.out,
    });
    expect(valueAnswer).toEqual({ action: "accept", answer: 42 });
  });

  it("rejects malformed URL input and exposes terminal-channel availability", async () => {
    const io = output();
    const interactive: Interactive = {
      isTTY: true,
      prompt: vi.fn().mockResolvedValue(""),
      confirm: vi.fn().mockResolvedValue(false),
    };
    const channel = createTerminalInputChannel(interactive, io.out, Code.parse("cli.test"));
    expect(channel.available(formRequest())).toBe(true);
    await expect(
      promptForInput(
        { ...formRequest(), mode: "url", url: "not a URL" },
        { interactive, out: io.out },
      ),
    ).rejects.toMatchObject({ code: "input_request_invalid" });

    const unavailable = createTerminalInputChannel(undefined, io.out, Code.parse("cli.test"));
    expect(unavailable.available(formRequest())).toBe(false);
  });
});
