// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDuration,
  formatMessage,
  formatNumber,
  getStrings,
  stringCatalog,
} from "./strings.js";

describe("shared UI string catalog", () => {
  it("falls back to the English catalog for supported and unknown locales", () => {
    expect(getStrings("en-US")).toBe(stringCatalog.en);
    expect(getStrings("fr-FR")).toBe(stringCatalog.en);
    expect(getStrings(undefined)).toBe(stringCatalog.en);
    expect(Object.values(stringCatalog.en).every((entry) => typeof entry === "string")).toBe(true);
  });

  it("formats numbers and durations in the host locale", () => {
    expect(formatNumber(1234, "de-DE")).toBe("1.234");
    expect(formatNumber(1234, "invalid_locale")).toBe("1,234");
    expect(formatDuration(250, "en-US")).toBe("250 ms");
  });

  it("formats dates with the host time zone and falls back on invalid locale data", () => {
    const time = Date.UTC(2026, 0, 2, 12);
    expect(formatDate(time, "en-US", "UTC")).toContain("Jan");
    expect(formatDate(time, "invalid_locale", "not-a-time-zone")).toContain("Jan");
  });

  it("formats catalog placeholders as text, localizes numbers, and preserves missing values", () => {
    expect(
      formatMessage(
        "Count {count}; name {name}; unknown {missing}",
        {
          count: 1234,
          name: "<img>",
        },
        "de-DE",
      ),
    ).toBe("Count 1.234; name <img>; unknown {missing}");
  });
});
