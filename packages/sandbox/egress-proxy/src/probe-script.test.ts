// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { parseJson } from "@harness/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { egressProbeScript, probeHelpers } from "./probe-script.js";

function makeHarness() {
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroy: vi.fn(() => response.emit("close")),
  });
  const socket = Object.assign(new EventEmitter(), {
    destroy: vi.fn(() => socket.emit("close")),
    setTimeout: vi.fn((_delay: number, callback: () => void) => socket.once("timeout", callback)),
  });
  const get = vi.fn((_options: unknown, callback: (incoming: unknown) => void) => {
    callback(response);
    return request;
  });
  const write = vi.fn<(fd: number, output: string) => void>();
  const exit = vi.fn();
  const modules: Record<string, unknown> = {
    "node:http": { get },
    "node:net": { connect: vi.fn(() => socket) },
    "node:fs": { writeSync: write },
  };
  const run = (script: string): unknown =>
    runInNewContext(script, {
      require: (name: string) => modules[name],
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      process: { env: { HTTP_PROXY: "http://proxy.test:3128" }, exit },
    });
  return { request, response, socket, get, write, exit, run };
}

describe("egress probe script", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("settles a response stalled after headers as probe_timeout and destroys its resources", async () => {
    const harness = makeHarness();
    const result = harness.run(
      `${probeHelpers}\nviaProxy("http://allowed.test/", new URL("http://proxy.test:3128"));`,
    );
    harness.response.emit("data", Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ status: -1, body: "probe_timeout" });
    expect(harness.request.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(harness.response.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a request that never receives headers", async () => {
    const harness = makeHarness();
    harness.get.mockImplementation(() => harness.request);
    const result = harness.run(
      `${probeHelpers}\nviaProxy("http://allowed.test/", new URL("http://proxy.test:3128"));`,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ status: -1, body: "probe_timeout" });
    expect(harness.request.destroy).toHaveBeenCalledExactlyOnceWith();
    harness.get.mock.calls[0]?.[1](harness.response);
    expect(harness.response.destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ["aborted", "response_aborted"],
    ["error", "response_failed"],
    ["close", "response_closed"],
  ])("refuses to treat a response %s as success", async (event, body) => {
    const harness = makeHarness();
    const result = harness.run(
      `${probeHelpers}\nviaProxy("http://allowed.test/", new URL("http://proxy.test:3128"));`,
    );
    harness.response.emit("data", Buffer.from("partial"));
    harness.response.emit(event);
    harness.response.emit("end");
    expect(await result).toEqual({ status: 0, body });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([["ECONNREFUSED"], [undefined]])("settles request errors with code %s", async (code) => {
    const harness = makeHarness();
    const result = harness.run(
      `${probeHelpers}\nviaProxy("http://allowed.test/", new URL("http://proxy.test:3128"));`,
    );
    harness.request.emit("error", { code });
    expect(await result).toEqual({ status: 0, body: code ?? "request_failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  // threat: T-05
  // threat: T-06
  it.each([
    ["connect", true],
    ["timeout", false],
    ["error", false],
    ["close", false],
  ])(
    "settles a direct socket %s without masking a successful connection",
    async (event, expected) => {
      const harness = makeHarness();
      const result = harness.run(`${probeHelpers}\ndirect("198.51.100.3", 8080);`);
      harness.socket.emit(event);
      expect(await result).toBe(expected);
      expect(harness.socket.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a connecting socket even if its inactivity timeout never fires", async () => {
    const harness = makeHarness();
    const result = harness.run(`${probeHelpers}\ndirect("198.51.100.3", 8080);`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ status: -1, body: "probe_timeout" });
    expect(harness.socket.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes partial results and the pending probe names before exiting from the watchdog", async () => {
    const harness = makeHarness();
    harness.run(`${probeHelpers}
      runProbes({
        allowed: () => ({ status: 200, body: "probe" }),
        denied: () => new Promise(() => {}),
        metadata: () => new Promise(() => {}),
      }, true);`);
    await vi.advanceTimersByTimeAsync(9999);
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      parseJson(z.record(z.string(), z.unknown()), harness.write.mock.calls[0]?.[1] ?? ""),
    ).toEqual({
      proxyEnvPresent: true,
      allowed: { status: 200, body: "probe" },
      pending: ["denied", "metadata"],
    });
    expect(harness.write.mock.calls[0]?.[0]).toBe(1);
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("records a thrown or rejected probe rather than leaving it pending", async () => {
    const harness = makeHarness();
    harness.run(`${probeHelpers}
      runProbes({
        thrown: () => { throw new Error("synthetic"); },
        rejected: () => Promise.reject(new Error("synthetic")),
      }, true);`);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      parseJson(z.record(z.string(), z.unknown()), harness.write.mock.calls[0]?.[1] ?? ""),
    ).toEqual({
      proxyEnvPresent: true,
      thrown: { status: 0, body: "probe_failed" },
      rejected: { status: 0, body: "probe_failed" },
      pending: [],
    });
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // threat: T-05
  // threat: T-06
  it("runs the exact injected scenario with unchanged security results and clears the watchdog", async () => {
    const harness = makeHarness();
    const outcomes = [
      { status: 200, body: "probe" },
      { status: 403, body: "not_allowlisted" },
      { status: 502, body: "private_address" },
    ];
    harness.get.mockImplementation((_options, callback) => {
      const outcome = outcomes.shift();
      const incoming = Object.assign(new EventEmitter(), {
        statusCode: outcome?.status,
        destroy: vi.fn(),
      });
      callback(incoming);
      queueMicrotask(() => {
        incoming.emit("data", Buffer.from(outcome?.body ?? ""));
        incoming.emit("end");
        incoming.emit("close");
      });
      return harness.request;
    });
    harness.run(egressProbeScript);
    await vi.advanceTimersByTimeAsync(0);
    harness.socket.emit("timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      parseJson(z.record(z.string(), z.unknown()), harness.write.mock.calls[0]?.[1] ?? ""),
    ).toEqual({
      proxyEnvPresent: true,
      allowed: { status: 200, body: "probe" },
      denied: { status: 403, body: "not_allowlisted" },
      metadata: { status: 502, body: "private_address" },
      directProbe: false,
      directMetadata: false,
      pending: [],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
