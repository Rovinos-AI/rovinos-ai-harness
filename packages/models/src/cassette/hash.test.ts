// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { requestHash } from "./hash.js";

const requestId = "00000000000000000000000001";

describe("requestHash", () => {
  it("ignores requestId and object key order at every level", () => {
    const first: ModelRequest = {
      requestId,
      model: { provider: "cassette", model: "test" },
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          toolId: "lookup",
          description: "Lookup",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    };
    const second: ModelRequest = {
      tools: [
        {
          inputSchema: { properties: { query: { type: "string" } }, type: "object" },
          description: "Lookup",
          toolId: "lookup",
        },
      ],
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      model: { model: "test", provider: "cassette" },
      requestId: "00000000000000000000000002",
    };

    expect(requestHash(first)).toBe(requestHash(second));
    expect(requestHash(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("preserves array order and hashes different request content differently", () => {
    const request: ModelRequest = {
      requestId,
      model: { provider: "cassette", model: "test" },
      messages: [{ role: "user", parts: [{ type: "text", text: "first" }] }],
    };

    expect(
      requestHash({
        ...request,
        messages: [{ role: "user", parts: [{ type: "text", text: "second" }] }],
      }),
    ).not.toBe(requestHash(request));
  });

  it("omits undefined object fields like JSON serialization", () => {
    const request: ModelRequest = {
      requestId,
      model: { provider: "cassette", model: "test" },
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    };

    expect(requestHash({ ...request, role: undefined })).toBe(requestHash(request));
    expect(requestHash({ ...request, output: undefined })).toBe(requestHash(request));
  });

  it("serializes undefined array elements as null", () => {
    const request: ModelRequest = {
      requestId,
      model: { provider: "cassette", model: "test" },
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    };
    const withUndefined = { ...request, messages: [undefined] } as unknown as ModelRequest;
    const withNull = { ...request, messages: [null] } as unknown as ModelRequest;

    expect(requestHash(withUndefined)).toBe(requestHash(withNull));
  });
});
