// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hostWidth, setDisplayMode } from "./layout.js";

describe("responsive display modes", () => {
  it.each(["inline", "fullscreen", "pip"] as const)("applies the %s mode", (mode) => {
    const root = document.createElement("main");
    setDisplayMode(root, mode);
    expect(root.dataset.displayMode).toBe(mode);
  });

  it("clamps host widths to usable screen sizes", () => {
    expect(hostWidth(320)).toBe("320px");
    expect(hostWidth(5000)).toBe("4096px");
    expect(hostWidth(undefined)).toBeUndefined();
    expect(hostWidth(319)).toBeUndefined();
    expect(hostWidth(Number.NaN)).toBeUndefined();
  });
});
