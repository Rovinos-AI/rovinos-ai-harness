// SPDX-License-Identifier: Apache-2.0
// Validation stays in the trial vault; a duplex exchange lets host repairs use its safe issues.
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { ModelPort } from "@rovinos/core";
import {
  applyValueTransform,
  ValueTransformResultSchema,
  type ValueTransformResult,
} from "@rovinos/models";
import { JsonValue, parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  LIVE_MODEL_MAX_BYTES,
  LiveModelError,
  LiveModelReplySchema,
} from "./live-model-contract.js";

const StreamFrameSchema = z.union([
  LiveModelReplySchema,
  z.object({ candidate: JsonValue }).strict(),
]);

/** Reads bounded newline-delimited frames without closing the duplex stream between frames. */
export async function* liveModelFrames(message: IncomingMessage): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const value of message) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) {
      throw new LiveModelError("eval_live_request_invalid");
    }
    pending = Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(10);
    while (newline !== -1) {
      if (newline > LIVE_MODEL_MAX_BYTES) {
        throw new LiveModelError("eval_live_request_invalid");
      }
      yield pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(10);
    }
    if (pending.length > LIVE_MODEL_MAX_BYTES) {
      throw new LiveModelError("eval_live_request_invalid");
    }
  }
  if (pending.length > 0) {
    throw new LiveModelError("eval_live_request_invalid");
  }
}

/** Encodes one bounded, schema-validated protocol frame. */
export function liveModelFrame(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIVE_MODEL_MAX_BYTES) {
    throw new LiveModelError("eval_live_response_invalid");
  }
  return `${text}\n`;
}

/** Receives a single required frame; EOF is never a successful validation. */
export async function nextLiveModelFrame(frames: AsyncGenerator<string>): Promise<string> {
  const next = await frames.next();
  if (next.done === true) {
    throw new LiveModelError("eval_live_request_invalid");
  }
  return next.value;
}

/** Validates the trial's value-preserving callback reply, never a resolved raw value. */
export async function liveModelTransformReply(
  frames: AsyncGenerator<string>,
): Promise<ValueTransformResult> {
  try {
    return parseJson(ValueTransformResultSchema, await nextLiveModelFrame(frames), {
      maxBytes: LIVE_MODEL_MAX_BYTES,
    });
  } catch {
    throw new LiveModelError("eval_live_request_invalid");
  }
}

async function consumeFrames(
  response: IncomingMessage,
  context: Parameters<ModelPort["complete"]>[1],
  write: (text: string) => void,
): Promise<z.infer<typeof LiveModelReplySchema>> {
  for await (const text of liveModelFrames(response)) {
    const frame = parseJson(StreamFrameSchema, text, { maxBytes: LIVE_MODEL_MAX_BYTES });
    if ("candidate" in frame) {
      if (context.outputSchema === undefined || context.valueTransform === undefined) {
        throw new LiveModelError("eval_live_response_invalid");
      }
      const result = await applyValueTransform(
        context.valueTransform,
        context.outputSchema,
        frame.candidate,
      );
      if (context.signal.aborted) {
        throw new LiveModelError("eval_live_cancelled");
      }
      write(liveModelFrame(result));
    } else {
      return frame;
    }
  }
  throw new LiveModelError("eval_live_response_invalid");
}

/** Exchanges candidates and safe validation results on the same cancellable Unix connection. */
export function completeLiveModelStream(
  socketPath: string,
  text: string,
  context: Parameters<ModelPort["complete"]>[1],
): Promise<z.infer<typeof LiveModelReplySchema>> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        socketPath,
        path: "/complete-tokenized",
        method: "POST",
        signal: context.signal,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        void consumeFrames(response, context, (frame) => {
          call.write(frame);
        })
          .then(resolve, reject)
          .finally(() => {
            call.destroy();
          });
      },
    );
    call.once("error", () => {
      reject(
        new LiveModelError(
          context.signal.aborted ? "eval_live_cancelled" : "eval_live_transport_failed",
        ),
      );
    });
    call.write(`${text}\n`);
  });
}
