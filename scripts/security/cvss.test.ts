// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { normalizeCvss, normalizeSeverity } from "./cvss.ts";

describe("CVSS normalization", () => {
  it("maps CVSS v3.1 base vectors to critical severity", () => {
    expect(
      normalizeCvss([
        {
          type: "CVSS_V3",
          score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        },
      ]),
    ).toBe("critical");
  });

  it("maps CVSS v3.0 base vectors to high severity", () => {
    expect(
      normalizeCvss([
        {
          type: "CVSS_V3",
          score: "CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N",
        },
      ]),
    ).toBe("high");
  });

  it("maps the maximum CVSS v2 score to high, not critical", () => {
    expect(
      normalizeCvss([
        {
          type: "CVSS_V2",
          score: "AV:N/AC:L/Au:N/C:C/I:C/A:C",
        },
      ]),
    ).toBe("high");
  });

  it("uses the highest supported severity when multiple vectors are present", () => {
    expect(
      normalizeCvss([
        { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:N" },
        { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      ]),
    ).toBe("critical");
  });

  it("fails closed for unsupported vectors and normalizes scanner labels", () => {
    expect(normalizeCvss([{ type: "CVSS_V4", score: "CVSS:4.0/unsupported" }])).toBeUndefined();
    expect(
      normalizeCvss([
        {
          type: "CVSS_V3",
          score: "CVSS:3.1/AV:Z/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        },
      ]),
    ).toBeUndefined();
    expect(normalizeSeverity("MEDIUM")).toBe("moderate");
    expect(normalizeSeverity("unrecognized")).toBe("unknown");
  });
});
