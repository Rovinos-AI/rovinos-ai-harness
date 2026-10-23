// SPDX-License-Identifier: Apache-2.0
import type { EventStore } from "@harness/store";
import type { McpServer } from "@modelcontextprotocol/server";
import { startRunResourceUpdates } from "./run-updates.js";
import type { RunResourceUpdatesError } from "./run-updates.js";

interface RunUpdateServerOptions {
  readonly onResourceUpdated?: (uri: string) => void;
  readonly onRunResourceUpdateError?: (error: RunResourceUpdatesError) => void;
  readonly subscribeRunUpdates?: boolean;
}

/** Connects run updates to one MCP server and closes the watcher with its session. */
export function configureRunResourceUpdates(
  server: McpServer,
  store: EventStore,
  options: RunUpdateServerOptions,
): void {
  if (options.subscribeRunUpdates === false) {
    return;
  }
  const notifyResourceUpdated =
    options.onResourceUpdated ??
    ((uri: string) => {
      void server.server
        .notification({ method: "notifications/resources/updated", params: { uri } })
        .catch(() => undefined);
    });
  const resourceUpdates = startRunResourceUpdates(store, notifyResourceUpdated, {
    ...(options.onRunResourceUpdateError === undefined
      ? {}
      : { onError: options.onRunResourceUpdateError }),
  });
  const mcpServer = server.server;
  mcpServer.onclose = () => {
    void resourceUpdates.close();
  };
}
