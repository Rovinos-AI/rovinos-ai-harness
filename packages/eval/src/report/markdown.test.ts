// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { reportGrade, reportTrial } from "../../test-utils/report.js";
import { buildEvalReport } from "./json.js";
import { renderMarkdownReport } from "./markdown.js";

describe("Markdown eval report", () => {
  it("renders a stable variant table and lists grader codes only", () => {
    const report = buildEvalReport({
      trials: [
        reportTrial({
          trialIndex: 0,
          result: {
            usage: { inputTokens: 2, outputTokens: 3, costMicros: 5 },
            durationMs: 100,
            metrics: {
              steps: 2,
              repairAttempts: 0,
              fallbackDepth: 0,
              deniedToolCalls: 0,
              budgetExceeded: false,
            },
          },
        }),
        reportTrial({
          trialIndex: 1,
          result: {
            usage: { inputTokens: 4, outputTokens: 5, costMicros: 10 },
            durationMs: 200,
            metrics: {
              steps: 4,
              repairAttempts: 0,
              fallbackDepth: 0,
              deniedToolCalls: 0,
              budgetExceeded: false,
            },
          },
        }),
      ],
      grades: [
        { taskId: "task_one", variantId: "baseline", trialIndex: 0, graders: [reportGrade(true)] },
        {
          taskId: "task_one",
          variantId: "baseline",
          trialIndex: 1,
          graders: [reportGrade(false, ["content_mismatch"])],
        },
      ],
    });

    expect(renderMarkdownReport(report)).toMatchInlineSnapshot(`
      "# Evaluation report

      ## Variant \`baseline\`

      | Task | Trials | Passes | Pass rate | pass@k | Cost mean / median / p95 (µUSD) | Tokens mean / median / p95 | Steps mean / median / p95 | Latency mean / median / p95 (ms) |
      | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
      | task_one | 2 | 1 | 50.0% | 1: 50.0%, 2: 100.0% | 7.5 / 7.5 / 10 | 7 / 7 / 9 | 3 / 3 / 4 | 150 / 150 / 200 |

      ## Failures

      - \`task_one\` / \`baseline\` trial 1: \`content_mismatch\`
      "
    `);
  });
});
