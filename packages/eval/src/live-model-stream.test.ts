// SPDX-License-Identifier: Apache-2.0
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  liveModelFrame,
  liveModelFrames,
  liveModelTransformReply,
  nextLiveModelFrame,
} from "./live-model-stream.js";
import { LIVE_MODEL_MAX_BYTES } from "./live-model-contract.js";

function message(chunks: readonly Buffer[], encoding?: BufferEncoding): IncomingMessage {
  const input = new IncomingMessage(new Socket());
  if (encoding !== undefined) {
    input.setEncoding(encoding);
  }
  for (const chunk of chunks) {
    input.push(chunk);
  }
  input.push(null);
  return input;
}

describe("bounded live-model stream frames", () => {
  it("preserves UTF-8 bytes split between chunks and multiple frames in one chunk", async () => {
    const bytes = Buffer.from('{"value":"é"}\n{"ok":true}\n');
    const frames = liveModelFrames(message([bytes.subarray(0, 11), bytes.subarray(11)]));
    expect(await nextLiveModelFrame(frames)).toBe('{"value":"é"}');
    expect(await nextLiveModelFrame(frames)).toBe('{"ok":true}');
    expect(await frames.next()).toEqual({ value: undefined, done: true });
  });

  it("rejects truncated frames and missing validation replies", async () => {
    await expect(
      nextLiveModelFrame(liveModelFrames(message([Buffer.from('{"ok":true}')]))),
    ).rejects.toMatchObject({ code: "eval_live_request_invalid" });
    await expect(nextLiveModelFrame(liveModelFrames(message([])))).rejects.toMatchObject({
      code: "eval_live_request_invalid",
    });
  });

  it.each(["", "\n"])("rejects oversized frames before parsing with terminator %j", async (end) => {
    const frames = liveModelFrames(
      message([Buffer.from(`${"x".repeat(LIVE_MODEL_MAX_BYTES + 1)}${end}`)]),
    );
    await expect(nextLiveModelFrame(frames)).rejects.toMatchObject({
      code: "eval_live_request_invalid",
    });
  });

  it("rejects non-buffer input and oversized outgoing frames", async () => {
    await expect(
      nextLiveModelFrame(liveModelFrames(message([Buffer.from("{}\n")], "utf8"))),
    ).rejects.toMatchObject({ code: "eval_live_request_invalid" });
    expect(() => liveModelFrame({ value: "x".repeat(LIVE_MODEL_MAX_BYTES) })).toThrow(
      "eval_live_response_invalid",
    );
    expect(liveModelFrame({ ok: true, tokenized: "<EMAIL_1>" })).toBe(
      '{"ok":true,"tokenized":"<EMAIL_1>"}\n',
    );
  });

  it("rejects malformed or value-bearing validation issues with a closed code", async () => {
    const frames = liveModelFrames(
      message([Buffer.from('{"ok":false,"issues":[],"raw":"synthetic-vault-canary"}\n')]),
    );
    await expect(liveModelTransformReply(frames)).rejects.toMatchObject({
      code: "eval_live_request_invalid",
      message: "eval_live_request_invalid",
    });
  });
});
