// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { InvalidEventError } from "./errors.js";
import { parseUsageLedgerDeltas } from "./types.js";
import { describe, expect, it } from "vitest";

describe("parseUsageLedgerDeltas", () => {
  it("combines matching periods and keeps the strictest run limit", () => {
    const result = parseUsageLedgerDeltas([
      {
        quotaId: Code.parse("analysts"),
        period: "hour",
        periodStart: 0,
        costMicros: 2,
        runsStarted: 1,
        maxRunsStarted: 8,
      },
      {
        quotaId: Code.parse("analysts"),
        period: "hour",
        periodStart: 0,
        costMicros: 3,
        runsStarted: 1,
        maxRunsStarted: 5,
      },
      {
        quotaId: Code.parse("analysts"),
        period: "hour",
        periodStart: 0,
        costMicros: 1,
        runsStarted: 1,
      },
      {
        quotaId: Code.parse("analysts"),
        period: "day",
        periodStart: 0,
        costMicros: 0,
        runsStarted: 1,
      },
      {
        quotaId: Code.parse("analysts"),
        period: "day",
        periodStart: 0,
        costMicros: 0,
        runsStarted: 1,
        maxRunsStarted: 4,
      },
    ]);

    expect(result).toEqual([
      {
        quotaId: Code.parse("analysts"),
        period: "hour",
        periodStart: 0,
        costMicros: 6,
        runsStarted: 3,
        maxRunsStarted: 5,
      },
      {
        quotaId: Code.parse("analysts"),
        period: "day",
        periodStart: 0,
        costMicros: 0,
        runsStarted: 2,
        maxRunsStarted: 4,
      },
    ]);
  });

  it("rejects malformed updates", () => {
    expect(() => parseUsageLedgerDeltas([{}])).toThrow(InvalidEventError);
  });
});
