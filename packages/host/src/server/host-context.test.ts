// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createHostContext } from "./host-context.js";

const options = {
  theme: "light",
  locale: "en-US",
  timeZone: "UTC",
  displayMode: "inline",
  availableDisplayModes: ["inline", "fullscreen"],
  maxWidth: 1024,
  maxHeight: 768,
} as const;

describe("createHostContext", () => {
  it("provides standard UX context, CSS variables, and container limits", () => {
    const context = createHostContext(options);
    expect(context).toMatchObject({
      theme: "light",
      locale: "en-US",
      timeZone: "UTC",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { maxWidth: 1024, maxHeight: 768 },
      platform: "web",
      styles: {
        variables: {
          "--color-background-primary": "#ffffff",
          "--color-text-primary": "#111827",
          "--font-sans": "system-ui, sans-serif",
          "--border-radius-md": "0.375rem",
        },
      },
    });
  });

  it("uses dark variables and passes through the supported display modes", () => {
    const context = createHostContext({
      ...options,
      theme: "dark",
      displayMode: "pip",
      availableDisplayModes: ["inline", "fullscreen", "pip"],
    });
    expect(context.theme).toBe("dark");
    expect(context.styles?.variables?.["--color-background-primary"]).toBe("#111827");
    expect(context.availableDisplayModes).toEqual(["inline", "fullscreen", "pip"]);
  });

  it("rejects invalid modes and dimensions", () => {
    expect(() => createHostContext({ ...options, displayMode: "pip" })).toThrow();
    expect(() => createHostContext({ ...options, maxWidth: 5000 })).toThrow();
    expect(() =>
      createHostContext({ ...options, availableDisplayModes: ["fullscreen"] }),
    ).toThrow();
    expect(() => createHostContext({ ...options, displayMode: "unsupported" })).toThrow();
  });
});
