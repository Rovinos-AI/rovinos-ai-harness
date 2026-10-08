// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const protectionScript = `${repositoryRoot}/scripts/github/apply-branch-protection.sh`;

describe("apply-branch-protection.sh", () => {
  it("prints the branch-protection payload with no required checks by default", () => {
    const result = spawnSync("bash", [protectionScript, "--dry-run"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchInlineSnapshot(`
      "{
        "required_status_checks": null,
        "required_pull_request_reviews": {
          "required_approving_review_count": 1
        },
        "enforce_admins": false,
        "restrictions": null,
        "allow_force_pushes": false,
        "allow_deletions": false,
        "required_conversation_resolution": true
      }
      "
    `);
  });

  it("prints configured required checks in dry-run mode", () => {
    const result = spawnSync(
      "bash",
      [protectionScript, "--dry-run", "--check", "Azure Pipelines / Rovinos AI Harness CI"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchInlineSnapshot(`
      "{
        "required_status_checks": {
          "strict": true,
          "contexts": ["Azure Pipelines / Rovinos AI Harness CI"]
        },
        "required_pull_request_reviews": {
          "required_approving_review_count": 1
        },
        "enforce_admins": false,
        "restrictions": null,
        "allow_force_pushes": false,
        "allow_deletions": false,
        "required_conversation_resolution": true
      }
      "
    `);
  });

  it("requires an explicit mode before changing branch protection", () => {
    const result = spawnSync("bash", [protectionScript], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects unknown arguments", () => {
    const result = spawnSync("bash", [protectionScript, "--unknown"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
});

describe("task issue form", () => {
  it("contains every task-spec field", () => {
    const formFile = `${repositoryRoot}/.github/ISSUE_TEMPLATE/task.yml`;
    const formText = readFileSync(formFile, "utf8");
    const formSchema = z
      .object({
        name: z.string(),
        description: z.string(),
        title: z.string(),
        labels: z.array(z.string()),
        body: z.array(
          z
            .object({
              type: z.enum(["input", "textarea"]),
              id: z.string(),
              attributes: z
                .object({
                  label: z.string(),
                  description: z.string(),
                })
                .strict(),
              validations: z.object({ required: z.boolean() }).strict(),
            })
            .strict(),
        ),
      })
      .strict();
    const form = parseYaml(formSchema, formText);

    expect(form.body.map((field) => field.attributes.label)).toEqual([
      "Parent",
      "Description",
      "Inputs",
      "Output",
      "Tests",
      "Acceptance",
      "Dependencies",
      "Depends on",
    ]);
  });
});
