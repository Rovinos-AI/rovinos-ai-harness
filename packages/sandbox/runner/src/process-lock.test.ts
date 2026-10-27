// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { systemRunnerCredentials, withRunnerProcessLock } from "./process-lock.js";

describe("runner process lock", () => {
  it("serializes credential-sensitive operations and continues after a rejection", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRunnerProcessLock(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = withRunnerProcessLock(() => {
      order.push("second");
      return Promise.reject(new Error("synthetic operation failure"));
    });
    const third = withRunnerProcessLock(() => {
      order.push("third");
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("synthetic operation failure");
    await third;
    expect(order).toEqual(["first-start", "first-end", "second", "third"]);
  });

  it("exposes the platform credential accessors without changing the current identity", () => {
    const userId = systemRunnerCredentials.geteuid();
    const groupId = systemRunnerCredentials.getegid();

    expect(userId).toBeTypeOf("number");
    expect(groupId).toBeTypeOf("number");
    if (userId !== undefined) {
      systemRunnerCredentials.seteuid?.(userId);
    }
    expect(systemRunnerCredentials.geteuid()).toBe(userId);
    if (groupId !== undefined) {
      systemRunnerCredentials.setegid?.(groupId);
    }
    expect(systemRunnerCredentials.getegid()).toBe(groupId);
  });
});
