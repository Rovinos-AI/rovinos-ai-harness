// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOutput } from "./output.js";
import { createTerminalPrompt } from "./prompt.js";

function setup(isTTY?: boolean) {
  const input = Object.assign(new PassThrough(), isTTY === undefined ? {} : { isTTY });
  const written: string[] = [];
  const out = createOutput({ stdout: (text) => written.push(text), stderr: () => undefined });
  return { input, written, prompt: createTerminalPrompt(input, out) };
}

describe("createTerminalPrompt", () => {
  it("reports TTY state and accepts only an explicit yes", async () => {
    const yes = setup(true);
    expect(yes.prompt.isTTY).toBe(true);
    const answer = yes.prompt.confirm("Go?");
    yes.input.write("YES\n");
    expect(await answer).toBe(true);
    expect(yes.written.join("")).toContain("Go? [y/N]");

    const no = setup();
    expect(no.prompt.isTTY).toBe(false);
    const declined = no.prompt.confirm("Go?");
    no.input.write("maybe\n");
    expect(await declined).toBe(false);
  });

  it("treats a closed input as no", async () => {
    const closed = setup(true);
    const answer = closed.prompt.confirm("Go?");
    closed.input.end();
    expect(await answer).toBe(false);
  });
});
