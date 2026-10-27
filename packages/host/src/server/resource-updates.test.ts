// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { MAX_HOST_REQUEST_BYTES } from "./http-utils.js";
import { subscribeResourceUpdates } from "./resource-updates.js";
import type { AppInstance, HostRequest, HostResponse } from "./types.js";

const sessionId = "00000000000000000000000001";
const instance: AppInstance = {
  id: "approval",
  resourceUri: "ui://harness/approval/v1",
  sessionId,
  end: () => undefined,
};

function makeRequest(value: string): HostRequest {
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield await Promise.resolve(value);
    },
  };
}

function makeResponse() {
  let closeListener: (() => void) | undefined;
  return {
    close: () => closeListener?.(),
    response: {
      headersSent: false,
      onClose(listener) {
        closeListener = listener;
        return () => {
          closeListener = undefined;
        };
      },
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn(),
    } satisfies HostResponse,
  };
}

describe("host run resource updates endpoint", () => {
  it("sends a pending update after the stream is ready and cleans up on close", async () => {
    const unsubscribe = vi.fn();
    let notify: (() => void) | undefined;
    const subscriptions = new Map<string, () => void>();
    const response = makeResponse();
    await subscribeResourceUpdates(
      makeRequest(JSON.stringify({ resourceUri: "harness://runs", sessionId })),
      response.response,
      {
        sessions: new Map([[sessionId, instance]]),
        resourceUpdateSubscriptions: subscriptions,
        dependencies: {
          subscribeResourceUpdates: (_uri, onUpdate) => {
            notify = onUpdate;
            onUpdate();
            return unsubscribe;
          },
        },
      },
    );

    expect(response.response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(response.response.write).toHaveBeenNthCalledWith(
      2,
      'data: {"uri":"harness://runs"}\n\n',
    );
    expect(subscriptions.has(sessionId)).toBe(true);
    response.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(response.response.end).toHaveBeenCalledOnce();
    expect(subscriptions.has(sessionId)).toBe(false);
    response.close();
    expect(response.response.end).toHaveBeenCalledOnce();
    notify?.();
    expect(response.response.write).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized requests and subscription failures", async () => {
    const oversizedResponse = makeResponse();
    await subscribeResourceUpdates(
      makeRequest("x".repeat(MAX_HOST_REQUEST_BYTES + 1)),
      oversizedResponse.response,
      { sessions: new Map(), resourceUpdateSubscriptions: new Map(), dependencies: {} },
    );
    expect(oversizedResponse.response.writeHead).toHaveBeenCalledWith(
      413,
      expect.any(Object),
    );

    const throwingResponse = makeResponse();
    await subscribeResourceUpdates(
      makeRequest(JSON.stringify({ resourceUri: "harness://runs", sessionId })),
      throwingResponse.response,
      {
        sessions: new Map([[sessionId, instance]]),
        resourceUpdateSubscriptions: new Map(),
        dependencies: {
          subscribeResourceUpdates: () => {
            throw new Error("synthetic subscription failure");
          },
        },
      },
    );
    expect(throwingResponse.response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));

    const missingUnsubscribeResponse = makeResponse();
    await subscribeResourceUpdates(
      makeRequest(JSON.stringify({ resourceUri: "harness://runs", sessionId })),
      missingUnsubscribeResponse.response,
      {
        sessions: new Map([[sessionId, instance]]),
        resourceUpdateSubscriptions: new Map(),
        dependencies: { subscribeResourceUpdates: () => undefined },
      },
    );
    expect(missingUnsubscribeResponse.response.writeHead).toHaveBeenCalledWith(
      503,
      expect.any(Object),
    );
  });

  it("returns code-only failures for invalid requests and unavailable subscriptions", async () => {
    const invalidResponse = makeResponse();
    await subscribeResourceUpdates(makeRequest("{"), invalidResponse.response, {
      sessions: new Map([[sessionId, instance]]),
      resourceUpdateSubscriptions: new Map(),
      dependencies: {},
    });
    expect(invalidResponse.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));

    const missingSessionResponse = makeResponse();
    await subscribeResourceUpdates(
      makeRequest(JSON.stringify({ resourceUri: "harness://runs", sessionId })),
      missingSessionResponse.response,
      { sessions: new Map(), resourceUpdateSubscriptions: new Map(), dependencies: {} },
    );
    expect(missingSessionResponse.response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));

    const unavailableResponse = makeResponse();
    await subscribeResourceUpdates(
      makeRequest(JSON.stringify({ resourceUri: "harness://runs", sessionId })),
      unavailableResponse.response,
      {
        sessions: new Map([[sessionId, instance]]),
        resourceUpdateSubscriptions: new Map(),
        dependencies: {},
      },
    );
    expect(unavailableResponse.response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  });
});
