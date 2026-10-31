// SPDX-License-Identifier: Apache-2.0
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { buildEvalReport } from "./json.js";
import { renderJunitReport } from "./junit.js";

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
    const errors: string[] = [];
    const testCases: string[] = [];
    const failureMessages: string[] = [];
    const parser = new SaxesParser();
    parser.on("error", (error) => errors.push(error.message));
    // cspell:ignore opentag
    parser.on("opentag", (tag) => {
      if (tag.name === "testcase") {
        testCases.push(tag.attributes.name);
      }
      if (tag.name === "failure") {
        const message = tag.attributes.message;
        if (typeof message === "string") {
          failureMessages.push(message);
        }
      }
    });
    parser.write(xml).close();

    expect(errors).toEqual([]);
    expect(testCases).toEqual(["task_one/baseline"]);
    expect(failureMessages).toEqual(["file_missing"]);
    expect(xml).not.toContain("/synthetic");
  });
});
