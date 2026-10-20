// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyHostContext, resolveTheme } from "./theme.js";

const originalMatchMedia: unknown = Reflect.get(window, "matchMedia");

function luminance(color: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

afterEach(() => {
  if (typeof originalMatchMedia === "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-display-mode");
});

describe("host theme context", () => {
  it("uses the system theme and sensible context defaults when the bridge is absent", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    const theme = resolveTheme(undefined, document);
    expect(theme.theme).toBe("dark");
    expect(theme.displayMode).toBe("inline");
    expect(theme.locale).toBe("en");
    expect(theme.timeZone).toBe("UTC");
    expect(theme.variables["--color-text-primary"]).toBe("#f1f5f9");
  });

  it("uses host variables and context while refusing non-color CSS values", () => {
    const resolved = resolveTheme(
      {
        theme: "light",
        displayMode: "pip",
        locale: "en-GB",
        timeZone: "Europe/London",
        styles: {
          variables: {
            "--color-text-primary": "#123456",
            "--color-background-primary": "url(https://example.test/track)",
          },
        },
      },
      document,
    );
    expect(resolved.theme).toBe("light");
    expect(resolved.displayMode).toBe("pip");
    expect(resolved.locale).toBe("en-GB");
    expect(resolved.timeZone).toBe("Europe/London");
    expect(resolved.variables["--color-text-primary"]).toBe("#123456");
    expect(resolved.variables["--color-background-primary"]).toBe("#ffffff");
  });

  it.each(["light", "dark"] as const)("keeps built-in %s theme text above AA contrast", (theme) => {
    const tokens = resolveTheme({ theme }, document).variables;
    const contrastPairs = [
      ["--color-text-primary", "--color-background-primary"],
      ["--color-text-primary", "--color-background-secondary"],
      ["--color-text-primary", "--color-background-tertiary"],
      ["--color-text-secondary", "--color-background-primary"],
      ["--color-text-disabled", "--color-background-primary"],
      ["--color-text-success", "--color-background-success"],
      ["--color-text-warning", "--color-background-warning"],
      ["--color-text-danger", "--color-background-danger"],
      ["--color-ring-primary", "--color-background-primary"],
    ] as const;
    for (const [foreground, background] of contrastPairs) {
      const text = tokens[foreground];
      const surface = tokens[background];
      if (text === undefined || surface === undefined) {
        throw new Error("Expected built-in theme colors");
      }
      expect(
        contrast(text, surface),
        `${theme}: ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies a theme, display mode, locale, safe colors, and bounded host width", () => {
    const resolved = applyHostContext(document.documentElement, {
      theme: "dark",
      displayMode: "fullscreen",
      locale: "en-CA",
      containerDimensions: { maxWidth: 5000 },
      styles: { variables: { "--color-text-primary": "#eeeeee" } },
    });
    expect(resolved.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.displayMode).toBe("fullscreen");
    expect(document.documentElement.lang).toBe("en-CA");
    expect(document.documentElement.style.getPropertyValue("--color-text-primary")).toBe("#eeeeee");
    expect(document.documentElement.style.getPropertyValue("--host-max-width")).toBe("4096px");
  });

  it.each([undefined, 319, 0])("does not apply an invalid host width: %s", (maxWidth) => {
    applyHostContext(document.documentElement, {
      containerDimensions: maxWidth === undefined ? {} : { maxWidth },
    });
    expect(document.documentElement.style.getPropertyValue("--host-max-width")).toBe("");
  });
});
