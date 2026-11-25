// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseYaml } from "@rovinos/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stepSchema = z.looseObject({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const workflowSchema = z.looseObject({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(
    z.string(),
    z.looseObject({
      if: z.string().optional(),
      "runs-on": z.string(),
      steps: z.array(stepSchema),
    }),
  ),
});

it("replays eval cassettes nightly, checks baseline, and uploads only the report", () => {
  const workflow = parseYaml(
    workflowSchema,
    readFileSync(resolve(root, ".github/workflows/eval-nightly.yml"), "utf8"),
  );
  const job = workflow.jobs["eval-replay"];
  const steps = job?.steps ?? [];
  const replay = steps.find((step) => step.name === "Replay eval suite from cassettes");
  const baseline = steps.find((step) => step.name === "Check eval baseline");
  const upload = steps.find((step) => step.name === "Upload metadata-only eval report");
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@") === true);

  expect(workflow.on.schedule).toEqual([{ cron: "0 3 * * *" }]);
  expect(workflow.on.workflow_dispatch).toEqual({});
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(job?.if).toBe("github.ref == 'refs/heads/main'");
  expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(steps.some((step) => step.uses === "./.github/actions/node-setup")).toBe(true);
  expect(replay?.run).toContain("--cassette replay");
  expect(replay?.run).toContain("--isolation inprocess");
  expect(baseline?.run).toContain("--baseline evals/baseline.json");
  expect(upload?.if).toBe("always()");
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
  expect(upload?.with?.path).toBe("reports/eval-report.json");
  expect(readFileSync(resolve(root, ".github/workflows/eval-nightly.yml"), "utf8")).not.toMatch(
    /AzureKeyVault|azureSubscription|api[_-]?key|token\s*:/iu,
  );
});
