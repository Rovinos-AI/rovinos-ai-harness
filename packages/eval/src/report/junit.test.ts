// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { buildEvalReport } from "./json.js";
import { renderJunitReport } from "./junit.js";

const JunitDocumentSchema = z
  .object({
    testsuite: z
      .object({
        "@_name": z.string(),
        "@_tests": z.string(),
        "@_failures": z.string(),
        testcase: z
          .array(
            z
              .object({
                "@_classname": z.string(),
                "@_name": z.string(),
                "@_time": z.string(),
                failure: z
                  .object({
                    "@_message": z.string(),
                    "@_type": z.string(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .min(1),
        "@_errors": z.string(),
      })
      .strict(),
  })
  .strict();

describe("JUnit eval report", () => {
  it("renders XML with one testcase per task/variant and grader-code failures", () => {
    const report = buildEvalReport({
      trials: [reportTrial(), reportTrial({ trialIndex: 1 })],
      grades: [
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graders: [reportGrade(true)] },
        {
          taskId: "task_one",
          variantId: "baseline",
          trialIndex: 1,
          graders: [reportGrade(false, ["file_missing"])],
        },
      ],
    });
    const xml = renderJunitReport(report);
    const document = parseJson(
      JunitDocumentSchema,
      JSON.stringify(
        new XMLParser({
          ignoreAttributes: false,
          ignoreDeclaration: true,
          isArray: (tagName) => tagName === "testcase",
        }).parse(xml),
      ),
    );

    expect(document.testsuite["@_tests"]).toBe("1");
    expect(document.testsuite["@_failures"]).toBe("1");
    expect(document.testsuite.testcase).toHaveLength(1);
    expect(document.testsuite.testcase[0]).toMatchObject({
      "@_name": "task_one/baseline",
      failure: { "@_message": "file_missing", "@_type": "assertion" },
    });
    expect(xml).not.toContain("/synthetic");
  });
});
