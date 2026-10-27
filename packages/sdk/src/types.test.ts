// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HarnessOverridesSchema, WatchOptionsSchema } from "./types.js";

describe("SDK option boundary schemas", () => {
  it("accepts adapter-shaped overrides only when their required capabilities are present", () => {
    const storeMethods = [
      "append",
      "appendWithSnapshot",
      "latestSnapshot",
      "read",
      "watch",
      "watchRuns",
      "head",
      "deleteRun",
      "listRuns",
      "findRunsByTrace",
      "fetchOutbox",
      "ackOutbox",
      "claimApprovalNotification",
      "markApprovalNotificationSent",
      "releaseApprovalNotification",
      "consumeConfirmationState",
      "close",
    ];
    const store = Object.fromEntries(storeMethods.map((method) => [method, () => undefined]));
    const accepted = HarnessOverridesSchema.safeParse({
      store,
      clock: { now: () => 1 },
      ids: { next: () => "synthetic" },
      model: { complete: () => Promise.resolve({}) },
      providerAdapters: [{ provider: "test", kind: "test", complete: () => Promise.resolve({}) }],
      secretResolver: { resolve: () => Promise.resolve({ reveal: () => "synthetic" }) },
      onKeysWarning: () => undefined,
      tool: { describe: () => undefined, execute: () => Promise.resolve({}) },
      policy: { decide: () => ({}) },
      context: { build: () => Promise.resolve({}) },
      scopeRegistry: { scopeOf: () => "scope", register: () => undefined },
      processLike: { on: () => undefined, removeListener: () => undefined, exit: () => undefined },
      flushTelemetry: () => Promise.resolve(),
    });

    expect(accepted.success).toBe(true);
    expect(
      HarnessOverridesSchema.safeParse({
        providerAdapters: [{ provider: "test", kind: "test" }],
        processLike: [],
        secretResolver: null,
      }).success,
    ).toBe(false);
  });

  it("validates optional AbortSignal capabilities in watch options", () => {
    const controller = new AbortController();
    expect(WatchOptionsSchema.parse({ signal: controller.signal }).signal).toBe(controller.signal);
    expect(WatchOptionsSchema.safeParse({ signal: null }).success).toBe(false);
  });
});
