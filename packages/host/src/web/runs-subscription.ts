// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@harness/schemas";
import { authorizedHeaders } from "./host.js";
import type { LaunchDetails } from "./host.js";
import { z } from "zod";

const ResourceUpdateSchema = z.object({ uri: z.literal("harness://runs") }).strict();

interface SubscribeRunsResourceOptions {
  readonly sessionId: string;
  readonly launch: LaunchDetails;
  readonly request: typeof fetch;
  readonly resourceUri: string;
  readonly onUpdate: () => void;
  readonly onClose: () => void;
}

/** Opens the host relay for run-resource updates and reports stream termination. */
export async function subscribeRunsResource(
  options: SubscribeRunsResourceOptions,
): Promise<(() => void) | undefined> {
  if (options.resourceUri !== "harness://runs") {
    return undefined;
  }
  const controller = new AbortController();
  let stream: ReadableStreamDefaultReader<Uint8Array>;
  const lifecycle = { active: true };
  try {
    const response = await options.request.call(globalThis, "/api/resource-updates", {
      method: "POST",
      headers: {
        ...authorizedHeaders(options.launch.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceUri: options.resourceUri,
        sessionId: options.sessionId,
      }),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      return undefined;
    }
    stream = response.body.getReader();
  } catch {
    return undefined;
  }
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (lifecycle.active) {
      const next = await stream.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data !== undefined) {
          parseJson(ResourceUpdateSchema, data);
          options.onUpdate();
        }
        frameEnd = buffer.indexOf("\n\n");
      }
    }
    if (lifecycle.active) {
      options.onClose();
    }
  })().catch(() => {
    if (lifecycle.active) {
      options.onClose();
    }
  });
  return () => {
    lifecycle.active = false;
    controller.abort();
    void stream.cancel().catch(() => undefined);
  };
}
