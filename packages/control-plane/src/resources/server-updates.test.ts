// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { configureRunResourceUpdates } from "./server-updates.js";

describe("server run resource updates", () => {
  it("does not subscribe when run updates are disabled", async () => {
    const store = new InMemoryEventStore();
    const server = {
      server: {
        notification: vi.fn(() => Promise.resolve()),
        onclose: undefined,
      },
    } as unknown as McpServer;

    configureRunResourceUpdates(server, store, { subscribeRunUpdates: false });

    expect(server.server.onclose).toBeUndefined();
    await store.close();
  });

  it("notifies resources by default and ignores notification transport failures", async () => {
    const store = new InMemoryEventStore();
    const builders = createEventBuilders();
    const runId = Id.parse("00000000000000000000000001");
    const notification = vi.fn(() => Promise.reject(new Error("synthetic transport failure")));
    const server = {
      server: {
        notification,
        onclose: undefined as (() => void) | undefined,
      },
    } as unknown as McpServer;
    configureRunResourceUpdates(server, store, {});

    await store.append(runId, [builders.runCreated(runId)], 0);
    await vi.waitFor(() => expect(notification).toHaveBeenCalled());
    server.server.onclose?.();
    await store.close();
  });
});
