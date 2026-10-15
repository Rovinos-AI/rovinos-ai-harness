// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { awaitRunValidation } from "./validation-deadline.js";

describe("awaitRunValidation", () => {
  it("rejects a run that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let started = false;

    await expect(
      awaitRunValidation(
        () => {
          started = true;
          return Promise.resolve("done");
        },
        { signal: controller.signal },
        { now: () => 0 },
      ),
    ).rejects.toMatchObject({
      message: "Run validation was cancelled.",
      cause: "cancelled",
    });
    expect(started).toBe(false);

    const cancelled = new AbortController();
    const cancellation = new Error("cancelled");
    cancelled.abort(cancellation);
    await expect(
      awaitRunValidation(
        () => Promise.resolve("done"),
        { signal: cancelled.signal },
        { now: () => 0 },
      ),
    ).rejects.toBe(cancellation);
  });

  it("returns validation completed before the run ends", async () => {
    const controller = new AbortController();

    await expect(
      awaitRunValidation(
        () => Promise.resolve("done"),
        { signal: controller.signal },
        { now: () => 0 },
      ),
    ).resolves.toBe("done");
  });

  it("rejects pending validation after cancellation and ignores its later result", async () => {
    const controller = new AbortController();
    let finishValidation = (): void => undefined;
    const validation = new Promise<string>((resolve) => {
      finishValidation = () => {
        resolve("late");
      };
    });
    const cancellation = new Error("cancelled");
    const result = awaitRunValidation(
      () => validation,
      { signal: controller.signal },
      { now: () => 0 },
    );

    controller.abort(cancellation);

    await expect(result).rejects.toBe(cancellation);
    finishValidation();
  });

  it("rejects a deadline that has already expired", async () => {
    const controller = new AbortController();
    let started = false;

    await expect(
      awaitRunValidation(
        () => {
          started = true;
          return Promise.resolve("done");
        },
        { signal: controller.signal, deadlineTs: 0 },
        { now: () => 0 },
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(started).toBe(false);
  });

  it("stops pending validation when the deadline timer expires", async () => {
    const controller = new AbortController();

    await expect(
      awaitRunValidation(
        () => new Promise<string>(() => undefined),
        { signal: controller.signal, deadlineTs: Date.now() + 5 },
        { now: () => Date.now() },
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
  });

  it("does not accept validation that completes after the deadline", async () => {
    const controller = new AbortController();
    let now = 0;

    await expect(
      awaitRunValidation(
        () => {
          now = 10;
          return Promise.resolve("done");
        },
        { signal: controller.signal, deadlineTs: 10 },
        { now: () => now },
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
  });

  it("preserves Error rejections", async () => {
    const controller = new AbortController();
    const failure = new Error("validation failed");

    await expect(
      awaitRunValidation(
        () => Promise.reject(failure),
        { signal: controller.signal },
        { now: () => 0 },
      ),
    ).rejects.toBe(failure);
  });
});
