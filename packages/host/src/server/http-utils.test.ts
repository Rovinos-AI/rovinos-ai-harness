// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { HostResponse } from "./types.js";
import { writeRequestFailure } from "./http-utils.js";

function makeResponse(headersSent: boolean): {
  readonly response: HostResponse;
  readonly writeHead: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const writeHead = vi.fn();
  const end = vi.fn();
  const destroy = vi.fn();
  const response: HostResponse = {
    headersSent,
    writeHead,
    write: vi.fn(() => true),
    end,
    destroy,
  };
  return { response, writeHead, end, destroy };
}

describe("writeRequestFailure", () => {
  it("writes a bounded error if the response has not started", () => {
    const { response, writeHead, end, destroy } = makeResponse(false);
    writeRequestFailure(response);
    expect(writeHead).toHaveBeenCalledExactlyOnceWith(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    expect(end).toHaveBeenCalledExactlyOnceWith('{"error":"app_host_request_failed"}');
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys a response whose headers have already been sent", () => {
    const { response, writeHead, end, destroy } = makeResponse(true);
    writeRequestFailure(response);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
