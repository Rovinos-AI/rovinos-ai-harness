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
  if: z.string().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  uses: z.string().optional(),
  steps: z.array(stepSchema).optional(),
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

  it("runs the reusable CI workflow before release verification", () => {
    const workflow = readWorkflow();

    expect(workflow.jobs.ci).toEqual({
      uses: "./.github/workflows/ci.yml",
      permissions: { contents: "read" },
    });
    expect(workflow.jobs.verify?.needs).toBe("ci");
    expect(workflow.jobs.verify?.if).toBe("needs.ci.outputs.gates == 'success'");
    expect(workflow.jobs.verify?.permissions).toEqual({ contents: "read" });
    expect(
      workflow.jobs.verify?.steps?.some((step) => step.name === "Verify gates check run"),
    ).toBe(false);
    expect(
      workflow.jobs.verify?.steps?.some((step) => step.name === "Check release community files"),
    ).toBe(true);
  });

  it("limits OIDC and registry write permissions to the publish job", () => {
    const workflow = readWorkflow();
    const verify = workflow.jobs.verify;
    const publish = workflow.jobs.publish;

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(verify?.permissions).toEqual({ contents: "read" });
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

  it("publishes verified packed tarballs after building the versioned images", () => {
    const workflow = readWorkflow();
    const publish = workflow.jobs.publish;
    const steps = publish?.steps ?? [];
    const imageBuild = steps.find((step) => step.name === "Build, push, and sign GHCR images");
    const npmPublish = steps.find(
      (step) => step.name === "Pack and publish npm packages with provenance",
    );
    const latest = steps.find((step) => step.name === "Move GHCR latest tags");
    const publishScript = npmPublish?.run ?? "";
    const imageBuildIndex = steps.findIndex((step) => step === imageBuild);
    const npmPublishIndex = steps.findIndex((step) => step === npmPublish);
    const latestIndex = steps.findIndex((step) => step === latest);

    expect(publish?.needs).toBe("verify");
    expect(imageBuild?.run).toContain("ghcr.io/$owner/harness");
    expect(imageBuild?.run).toContain("ghcr.io/$owner/harness-sandbox");
    expect(imageBuild?.run).not.toContain("sandbox-runner");
    expect(imageBuild?.run).not.toContain("sandbox-egress-proxy");
    expect(publishScript).toContain('yarn pack --out "$tarball"');
    expect(publishScript).toContain('tar -xOf "$tarball" package/package.json');
    expect(publishScript).toContain("grep -F '\"workspace:' >/dev/null");
    expect(publishScript).toContain('npm view "$name@$version" version');
    expect(publishScript).toContain('npm publish "$tarball" --provenance --access public');
    expect(imageBuildIndex).toBeGreaterThanOrEqual(0);
    expect(npmPublishIndex).toBeGreaterThan(imageBuildIndex);
    expect(latestIndex).toBeGreaterThan(npmPublishIndex);
    expect(latest?.run).toContain("imagetools create");
    expect(latest?.run).toContain(":latest");
  });

  it("skips creation when the GitHub Release already exists", () => {
    const release = readWorkflow().jobs.publish?.steps?.find(
      (step) => step.name === "Create GitHub Release",
    );

    expect(release?.run).toContain('gh release view "$GITHUB_REF_NAME"');
    expect(release?.run).toContain("already exists; skipping.");
  });

  it("contains no stored publishing token and pins every third-party action", () => {
    const workflow = readWorkflow();
    const source = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    const remoteActions = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./"));

    expect(source).not.toMatch(/NPM_TOKEN|secrets\./u);
    expect(remoteActions.length).toBeGreaterThan(0);
    expect(remoteActions.filter((uses) => !pinnedAction.test(uses))).toEqual([]);
  });
});
