// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { extractJson } from "./extract-json.js";

describe("extractJson", () => {
  it("extracts fenced JSON", () => {
    expect(extractJson('```json\n{"answer":"ok"}\n```')).toEqual({
      ok: true,
      value: { answer: "ok" },
    });
  });

  it("extracts JSON between leading and trailing prose", () => {
    expect(extractJson('Here is the result: {"answer":"ok"} Thanks!')).toEqual({
      ok: true,
      value: { answer: "ok" },
    });
  });

  it("skips balanced non-JSON brace groups in prose", () => {
    expect(extractJson('Here is the result {see below}: {"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("ignores nested braces inside strings", () => {
    expect(extractJson('{"answer":"{nested}"}')).toEqual({
      ok: true,
      value: { answer: "{nested}" },
    });
  });

  it("tracks escaped quotes inside strings", () => {
    expect(extractJson('{"answer":"She said \\"{ok}\\""}')).toEqual({
      ok: true,
      value: { answer: 'She said "{ok}"' },
    });
  });

  it("extracts arrays", () => {
    expect(extractJson('Result: [1,{"answer":"ok"}]')).toEqual({
      ok: true,
      value: [1, { answer: "ok" }],
    });
  });

  it.each(['{"answer":"truncated"', "{not-json}"])(
    "returns invalid_json for malformed or truncated JSON: %s",
    (text) => {
      expect(extractJson(text)).toEqual({ ok: false, code: "invalid_json" });
    },
  );

  it("returns no_json when the text contains no object or array", () => {
    expect(extractJson("No structured value was returned.")).toEqual({
      ok: false,
      code: "no_json",
    });
  });
});
