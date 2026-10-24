// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stepSchema = z.looseObject({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
});
const jobSchema = z.looseObject({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.looseObject({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), jobSchema),
});
const pinnedAction = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/u;

function readWorkflow(): z.infer<typeof workflowSchema> {
  return parseYaml(
    workflowSchema,
    readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"),
  );
}

describe("release workflow", () => {
  it("runs only for version tags", () => {
    const { on } = readWorkflow();

    expect(Object.keys(on)).toEqual(["push"]);
    expect(on.push).toEqual({ tags: ["v*"] });
  });

  it("limits OIDC and registry write permissions to the publish job", () => {
    const workflow = readWorkflow();
    const verify = workflow.jobs.verify;
    const publish = workflow.jobs.publish;

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(verify?.permissions).toEqual({ checks: "read", contents: "read" });
    expect(publish?.permissions).toEqual({
      contents: "write",
      packages: "write",
      "id-token": "write",
    });
    expect(
      Object.entries(workflow.jobs)
        .filter(([name]) => name !== "publish")
        .some(([, job]) => job.permissions?.["id-token"] === "write"),
    ).toBe(false);
  });

  it("verifies the gates check before the publish job can run", () => {
    const workflow = readWorkflow();
    const verify = workflow.jobs.verify;
    const publish = workflow.jobs.publish;
    const gates = verify?.steps.find((step) => step.name === "Verify gates check run");

    expect(gates?.run).toContain("/check-runs");
    expect(gates?.run).toContain("length > 0");
    expect(gates?.run).toContain('last.status == "completed"');
    expect(gates?.run).toContain('last.conclusion == "success"');
    expect(publish?.needs).toBe("verify");
    expect(verify?.steps.some((step) => step.run?.includes("npm publish") === true) === true).toBe(
      false,
    );
    expect(
      publish?.steps.some(
        (step) => step.run?.includes("npm publish --provenance --access public") === true,
      ) === true,
    ).toBe(true);
  });

  it("contains no stored publishing token and pins every third-party action", () => {
    const workflow = readWorkflow();
    const source = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    const remoteActions = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./"));

    expect(source).not.toMatch(/NPM_TOKEN|secrets\./u);
    expect(remoteActions.length).toBeGreaterThan(0);
    expect(remoteActions.filter((uses) => !pinnedAction.test(uses))).toEqual([]);
  });
});
