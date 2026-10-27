// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { RunnerRequest } from "./request-handler.js";
import { authorityFrom, validHost, validOrigin } from "./server-origin.js";

function requestWithHeaders(headers: RunnerRequest["headers"]): RunnerRequest {
  return Object.assign(Readable.from([]), { headers });
}

describe("runner request origin validation", () => {
  it("normalizes authorities and rejects userinfo, paths, and malformed values", () => {
    expect(authorityFrom("RUNNER.EXAMPLE:8080")).toBe("runner.example:8080");
    for (const value of [undefined, "", " runner.example", "user@runner.example", "runner.example/path", "[bad"]) {
      expect(authorityFrom(value)).toBeUndefined();
    }
  });

  it("allows absent origins and accepts only approved HTTP origins", () => {
    const allowed = new Set(["runner.example:8080"]);
    expect(validOrigin(undefined, allowed)).toBe(true);
    expect(validOrigin("http://RUNNER.EXAMPLE:8080", allowed)).toBe(true);
    expect(validOrigin("https://runner.example:8080", allowed)).toBe(true);
    for (const origin of [
      "ftp://runner.example:8080",
      "http://user@runner.example:8080",
      "http://runner.example:8080/path",
      "http://runner.example:8080?query",
      "http://runner.example:8080#fragment",
      "not an origin",
      "http://other.example",
    ]) {
      expect(validOrigin(origin, allowed)).toBe(false);
    }
  });

  it("validates the request Host against the approved authority set", () => {
    const allowed = new Set(["runner.example:8080"]);
    expect(validHost(requestWithHeaders({ host: "runner.example:8080" }), allowed)).toBe(true);
    expect(validHost(requestWithHeaders({ host: "other.example" }), allowed)).toBe(false);
    expect(validHost(requestWithHeaders({}), allowed)).toBe(false);
  });
});
