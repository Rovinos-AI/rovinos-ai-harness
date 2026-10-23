// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { subscribeRunsResource } from "./runs-subscription.js";
import type { LaunchDetails } from "./host.js";

const launch: LaunchDetails = {
  token: "t".repeat(43),
  resourceUri: "ui://harness/runs/v1",
};

function updateStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"uri":"harness://runs"}\n\n'));
      controller.close();
    },
  });
}

describe("run resource host subscription", () => {
  it("relays validated updates and reports stream closure", async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(updateStream())));
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    const unsubscribe = await subscribeRunsResource({
      sessionId: "00000000000000000000000001",
      launch,
      request,
      resourceUri: "harness://runs",
      onUpdate,
      onClose,
    });

    expect(unsubscribe).toBeTypeOf("function");
    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(request).toHaveBeenCalledWith(
      "/api/resource-updates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          resourceUri: "harness://runs",
          sessionId: "00000000000000000000000001",
        }),
      }),
    );
    unsubscribe?.();
  });

  it("does not open other resources and falls back when the relay is unavailable", async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 })));

    await expect(
      subscribeRunsResource({
        sessionId: "00000000000000000000000001",
        launch,
        request,
        resourceUri: "harness://other",
        onUpdate: () => undefined,
        onClose: () => undefined,
      }),
    ).resolves.toBeUndefined();
    await expect(
      subscribeRunsResource({
        sessionId: "00000000000000000000000001",
        launch,
        request,
        resourceUri: "harness://runs",
        onUpdate: () => undefined,
        onClose: () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports malformed stream data as a lost subscription", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"uri":"harness://other"}\n\n'));
      },
    });
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(stream)));
    const onClose = vi.fn();

    const unsubscribe = await subscribeRunsResource({
      sessionId: "00000000000000000000000001",
      launch,
      request,
      resourceUri: "harness://runs",
      onUpdate: () => undefined,
      onClose,
    });

    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    unsubscribe?.();
  });
});
