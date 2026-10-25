// SPDX-License-Identifier: Apache-2.0
// Structure and security checks for the GitHub Actions CI workflow (task 1.21). The workflow runs
// untrusted PR code, so its token, triggers, and action pins are guarded here, not by review alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@rovinos/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const stepSchema = z.looseObject({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const jobSchema = z.looseObject({
  needs: z.string().optional(),
  if: z.string().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  "runs-on": z.string(),
  "timeout-minutes": z.number().int().positive(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.looseObject({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  concurrency: z.looseObject({
    group: z.string(),
    "cancel-in-progress": z.boolean(),
  }),
  jobs: z.record(z.string(), jobSchema),
});
const workflowCallSchema = z.looseObject({
  outputs: z.record(z.string(), z.looseObject({ value: z.string().optional() })).optional(),
});
const actionSchema = z.looseObject({
  runs: z.looseObject({ using: z.literal("composite"), steps: z.array(stepSchema) }),
});
const copilotSetupWorkflowSchema = z.looseObject({
  on: z.record(z.string(), z.unknown()),
  jobs: z.record(
    z.string(),
    z.looseObject({
      "runs-on": z.string(),
      "timeout-minutes": z.number().int().positive(),
      permissions: z.record(z.string(), z.string()),
      steps: z.array(stepSchema),
    }),
  ),
});

type Step = z.infer<typeof stepSchema>;

function readWorkflow(): z.infer<typeof workflowSchema> {
  return parseYaml(workflowSchema, readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
}

function readSetupAction(): z.infer<typeof actionSchema> {
  return parseYaml(
    actionSchema,
    readFileSync(resolve(root, ".github/actions/node-setup/action.yml"), "utf8"),
  );
}

function readCopilotSetupWorkflow(): z.infer<typeof copilotSetupWorkflowSchema> {
  return parseYaml(
    copilotSetupWorkflowSchema,
    readFileSync(resolve(root, ".github/workflows/copilot-setup-steps.yml"), "utf8"),
  );
}

function jobSteps(name: string): Step[] {
  const job = readWorkflow().jobs[name];
  if (job === undefined) {
    throw new TypeError(`Workflow must contain the ${name} job.`);
  }
  return job.steps;
}

function stepRunning(steps: readonly Step[], command: string): Step | undefined {
  return steps.find((step) => step.run?.includes(command) === true);
}

const pinnedAction = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u;

describe("GitHub workflows", () => {
  it("runs on pull requests to main without privileged triggers", () => {
    const workflow = readWorkflow();

    expect(Object.keys(workflow.on).sort()).toEqual([
      "pull_request",
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(workflow.on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    });
  });

  describe("Copilot setup workflow", () => {
    it("runs manually and when its own workflow file changes", () => {
      expect(readCopilotSetupWorkflow().on).toEqual({
        workflow_dispatch: {},
        push: { paths: [".github/workflows/copilot-setup-steps.yml"] },
        pull_request: { paths: [".github/workflows/copilot-setup-steps.yml"] },
      });
    });

    it("uses the required setup job with read-only permissions", () => {
      const { jobs } = readCopilotSetupWorkflow();

      expect(Object.keys(jobs)).toEqual(["copilot-setup-steps"]);
      expect(jobs["copilot-setup-steps"]).toMatchObject({
        "runs-on": "ubuntu-latest",
        permissions: { contents: "read" },
      });
    });

    it("uses SHA-pinned checkout, disables persisted credentials, and runs shared setup", () => {
      const job = readCopilotSetupWorkflow().jobs["copilot-setup-steps"];
      if (job === undefined) {
        throw new TypeError("The Copilot setup workflow must contain its setup job.");
      }

      const checkout = job.steps.find(
        (step) => step.uses?.startsWith("actions/checkout@") === true,
      );
      expect(checkout?.uses).toMatch(pinnedAction);
      expect(checkout?.uses).toBe(jobSteps("static")[0]?.uses);
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
      expect(
        job.steps
          .map((step) => step.uses)
          .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./"))
          .filter((uses) => !pinnedAction.test(uses)),
      ).toEqual([]);
      expect(job.steps.some((step) => step.uses === "./.github/actions/node-setup")).toBe(true);
      expect(
        job.steps.some(
          (step) => step.run?.includes("scripts/lint-extended.ts pull-images") === true,
        ),
      ).toBe(true);
      expect(job.steps.some((step) => step.run?.includes("yarn build") === true)).toBe(true);
    });
  });

  it("grants the token read-only repository access", () => {
    expect(readWorkflow().permissions).toEqual({ contents: "read" });
  });

  it("isolates draft and ready pull request concurrency groups", () => {
    expect(readWorkflow().concurrency).toEqual({
      group:
        "ci-${{ github.event.pull_request.number || github.ref }}-${{ github.event.pull_request.draft }}",
      "cancel-in-progress": true,
    });
  });

  it("runs the CI jobs in order and skips draft pull requests", () => {
    const { jobs } = readWorkflow();

    expect(Object.keys(jobs)).toEqual(["static", "unit", "integration", "gates"]);
    expect(jobs.static?.if).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );
    expect(jobs.unit?.needs).toBe("static");
    expect(jobs.integration?.needs).toBe("unit");
    expect(jobs.gates?.needs).toBe("integration");
  });

  it("runs static checks except for draft pull requests", () => {
    const condition = readWorkflow().jobs.static?.if;

    expect(condition).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );

    const shouldRun = (eventName: string, draft: boolean | undefined): boolean =>
      eventName !== "pull_request" || draft === false;

    expect(shouldRun("push", undefined)).toBe(true);
    expect(shouldRun("pull_request", true)).toBe(false);
    expect(shouldRun("pull_request", false)).toBe(true);
  });

  it("exposes the gates job result to reusable workflow callers", () => {
    const workflow = readWorkflow();
    const workflowCall = workflowCallSchema.parse(workflow.on.workflow_call);

    expect(workflowCall.outputs?.gates?.value).toBe("${{ jobs.gates.outputs.result }}");
    expect(workflow.jobs.gates?.outputs?.result).toBe(
      "${{ steps.report-gates-result.outputs.result }}",
    );
    const reportResult = jobSteps("gates").find((step) => step.id === "report-gates-result");
    expect(reportResult?.if).toBe("always()");
    expect(reportResult?.env?.GATES_RESULT).toBe("${{ job.status }}");
    expect(reportResult?.run).toContain('echo "result=$GATES_RESULT" >> "$GITHUB_OUTPUT"');
  });

  it("pins every action to a full commit SHA", () => {
    const steps = [
      ...Object.values(readWorkflow().jobs).flatMap((job) => job.steps),
      ...readSetupAction().runs.steps,
    ];
    const remote = steps
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./"));

    expect(remote.length).toBeGreaterThan(0);
    expect(remote.filter((uses) => !pinnedAction.test(uses))).toEqual([]);
  });

  it("never persists checkout credentials", () => {
    for (const job of Object.values(readWorkflow().jobs)) {
      const checkout = job.steps.find(
        (step) => step.uses?.startsWith("actions/checkout@") === true,
      );
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("runs the static checks, with DCO against the pull request's base branch", () => {
    const steps = jobSteps("static");

    const required = [
      "yarn lint:claims",
      "yarn lint",
      "yarn typecheck",
      "yarn check:agents",
      "yarn check:spdx",
      "yarn check:licenses",
      "node packages/cli/dist/bin.js policy test",
      "node packages/cli/dist/bin.js policy lint",
    ];
    expect(required.filter((command) => stepRunning(steps, command) === undefined)).toEqual([]);
    const dco = stepRunning(steps, "yarn check:dco");
    expect(dco?.if).toBe("github.event_name == 'pull_request'");
    expect(dco?.env).toEqual({ TARGET_BRANCH: "${{ github.base_ref }}" });
    expect(steps[0]?.with?.["fetch-depth"]).toBe(0);
  });

  it("requires a Changeset for non-documentation package changes", () => {
    const step = jobSteps("static").find(
      (candidate) => candidate.name === "Check Changesets status",
    );

    expect(step?.run).toContain("git diff --name-only origin/main...HEAD -- packages");
    expect(step?.run).toContain("yarn changeset status --since=origin/main");
    expect(step?.run).toContain("Package changes require a Changeset.");
  });

  it("runs the release path in dry-run mode without publishing", () => {
    const step = jobSteps("static").find((candidate) => candidate.name === "Release path dry run");

    expect(step?.run).toContain("scripts/release/verify-release.ts --dry-run");
    expect(step?.run).toContain('cd "packages/$package" && yarn pack --dry-run');
    expect(step?.run).not.toContain("docker build");
    expect(step?.run).not.toContain("docker push");
    expect(step?.run).not.toContain("npm publish");
  });

  it("reports unit results with coverage even when tests fail", () => {
    const unit = stepRunning(jobSteps("unit"), "yarn test:unit");

    expect(unit?.run).toContain("--reporter=junit");
    expect(unit?.run).toContain("--coverage.reportOnFailure");
    expect(unit?.run).toContain("--coverage.reporter=cobertura");
    expect(unit?.run).toContain("--maxWorkers=2");
    const upload = jobSteps("unit").find((step) => step.name === "Upload unit reports");
    expect(upload?.if).toBe("success() || failure()");
  });

  it("isolates the integration Compose project and always tears it down", () => {
    const integration = readWorkflow().jobs.integration;
    const steps = jobSteps("integration");
    const teardown = stepRunning(steps, "down -v --remove-orphans");

    expect(integration?.env).toEqual({ COMPOSE_PROJECT_NAME: "harness-ci-${{ github.run_id }}" });
    expect(stepRunning(steps, "scripts/ci/compose-wait.sh")).toBeDefined();
    expect(teardown?.if).toBe("always()");
    expect(steps.at(-1)).toBe(teardown);
  });

  it("runs the canary and replay release gates", () => {
    const steps = jobSteps("gates");
    const canary = stepRunning(steps, "yarn test:canary");
    const replay = stepRunning(steps, "yarn test:replay");

    expect(canary).toBeDefined();
    expect(stepRunning(steps, "yarn build")).toBeDefined();
    expect(replay).toBeDefined();
    if (canary === undefined || replay === undefined) {
      throw new TypeError("The gates job must run both canary and replay tests.");
    }
    expect(steps.indexOf(replay)).toBeGreaterThan(steps.indexOf(canary));
  });

  it("verifies the pinned mise download before installing it", () => {
    const install = readSetupAction().runs.steps.find((step) => step.name === "Install mise");

    expect(install?.run).toMatch(/MISE_SHA256=[0-9a-f]{64}/u);
    expect(install?.run).toContain("sha256sum --check --status");
  });
});
