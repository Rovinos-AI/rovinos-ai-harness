// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { PiiDestinationError, resolveDestination } from "./destination.js";

describe("resolveDestination", () => {
  it.each([
    ["model_input", "local", "local"],
    ["model_input", "hosted", "hosted"],
    ["model_input", undefined, "hosted"],
    ["storage", undefined, "any"],
    ["ui", undefined, "any"],
  ] as const)("resolves %s for %s trust", (boundary, trust, expected) => {
    expect(
      resolveDestination({
        boundary,
        ...(trust === undefined ? {} : { provider: { trust } }),
      }),
    ).toEqual(expected);
  });

  it.each(["tool_input", "tool_output"] as const)("resolves %s to its tool", (boundary) => {
    expect(resolveDestination({ boundary, toolId: Code.parse("mail.send") })).toEqual({
      tool: "mail.send",
    });
  });

  it.each(["tool_input", "tool_output"] as const)(
    "fails closed when %s has no tool identifier",
    (boundary) => {
      expect(() => resolveDestination({ boundary })).toThrow(PiiDestinationError);
    },
  );
});
