// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("bounds concurrency and releases permits when operations finish", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maximum = 0;
    const run = (): Promise<void> =>
      semaphore.run(new AbortController().signal, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
      });

    await Promise.all([run(), run(), run(), run()]);

    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("rejects an aborted waiter without consuming a permit", async () => {
    const semaphore = new Semaphore(1);
    let finishFirst: (() => void) | undefined;
    const first = semaphore.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await Promise.resolve();
    const controller = new AbortController();
    const second = semaphore.run(controller.signal, () => Promise.resolve());
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("already aborted"));
    await expect(semaphore.run(alreadyAborted.signal, () => Promise.resolve())).rejects.toThrow(
      "already aborted",
    );
    const cancel = new Error("cancelled");
    controller.abort(cancel);

    await expect(second).rejects.toBe(cancel);
    finishFirst?.();
    await first;
    await expect(
      semaphore.run(new AbortController().signal, () => Promise.resolve("available")),
    ).resolves.toBe("available");
  });

  it("releases a permit after an operation fails", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(new AbortController().signal, () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    await expect(
      semaphore.run(new AbortController().signal, () => Promise.resolve("available")),
    ).resolves.toBe("available");
  });

  it("validates the concurrency bound", () => {
    expect(() => new Semaphore(0)).toThrow("maxConcurrent must be a positive integer.");
  });
});
