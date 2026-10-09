// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandler, type ShutdownProcessLike } from "./index.js";

class FakeProcess implements ShutdownProcessLike {
  exitCode: number | undefined;
  readonly exits: number[] = [];
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", (() => void)[]>();

  once(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    const listeners = this.listeners.get(signal) ?? [];
    this.listeners.set(signal, [...listeners, listener]);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((registered) => registered !== listener),
    );
    return this;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    const listeners = this.listeners.get(signal) ?? [];
    this.listeners.set(signal, []);
    for (const listener of listeners) {
      listener();
    }
  }

  listenerCount(signal: "SIGINT" | "SIGTERM"): number {
    return this.listeners.get(signal)?.length ?? 0;
  }

  exit(code: number): void {
    this.exits.push(code);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installShutdownHandler", () => {
  it("aborts once with the matching signal exit code and can be uninstalled", () => {
    const processLike = new FakeProcess();
    const controller = new AbortController();
    const onTimeout = vi.fn();
    const uninstall = installShutdownHandler({
      processLike,
      controller,
      graceMs: 100,
      onTimeout,
    });

    processLike.emit("SIGTERM");
    processLike.emit("SIGINT");
    expect(controller.signal.reason).toBe("shutdown");
    expect(processLike.exitCode).toBe(143);
    expect(onTimeout).not.toHaveBeenCalled();
    uninstall();
    processLike.emit("SIGINT");
    expect(processLike.listenerCount("SIGINT")).toBe(0);
    expect(processLike.exitCode).toBe(143);
  });

  it("attempts the timeout callback, logs the timeout, and forces exit code one", async () => {
    vi.useFakeTimers();
    const processLike = new FakeProcess();
    const controller = new AbortController();
    const onTimeout = vi.fn();
    const logger = { error: vi.fn() };
    installShutdownHandler({
      processLike,
      controller,
      graceMs: 10,
      onTimeout,
      logger,
    });

    processLike.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(10);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("shutdown_timeout");
    expect(processLike.exitCode).toBe(1);
    expect(processLike.exits).toEqual([1]);
  });

  it("still forces exit when the best-effort timeout callback fails", async () => {
    vi.useFakeTimers();
    const processLike = new FakeProcess();
    const logger = { error: vi.fn() };
    installShutdownHandler({
      processLike,
      controller: new AbortController(),
      graceMs: 10,
      onTimeout: () => Promise.reject(new Error("checkpoint failed")),
      logger,
    });

    processLike.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);

    expect(logger.error).toHaveBeenCalledWith("shutdown_timeout");
    expect(processLike.exits).toEqual([1]);
  });

  it("still forces exit when timeout logging fails", async () => {
    vi.useFakeTimers();
    const processLike = new FakeProcess();
    installShutdownHandler({
      processLike,
      controller: new AbortController(),
      graceMs: 10,
      onTimeout: () => undefined,
      logger: {
        error: () => {
          throw new Error("logger failed");
        },
      },
    });

    processLike.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);

    expect(processLike.exits).toEqual([1]);
  });

  it("clears the pending timer on uninstall", async () => {
    vi.useFakeTimers();
    const processLike = new FakeProcess();
    const onTimeout = vi.fn();
    const uninstall = installShutdownHandler({
      processLike,
      controller: new AbortController(),
      graceMs: 10,
      onTimeout,
    });
    processLike.emit("SIGTERM");
    uninstall();

    await vi.advanceTimersByTimeAsync(10);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(processLike.exits).toEqual([]);
  });
});
