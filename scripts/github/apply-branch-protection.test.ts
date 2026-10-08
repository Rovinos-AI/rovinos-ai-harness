// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const protectionScript = `${repositoryRoot}/scripts/github/apply-branch-protection.sh`;

describe("apply-branch-protection.sh", () => {
  it("prints the required branch-protection payload in dry-run mode", () => {
    const result = spawnSync("bash", [protectionScript, "--dry-run"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchInlineSnapshot(`
      "{
        "required_status_checks": {
          "strict": true,
          "contexts": [
            "Azure Pipelines / Rovinos AI Harness CI",
            "DCO"
          ]
        },
        "required_pull_request_reviews": {
          "required_approving_review_count": 1
        },
        "enforce_admins": true,
        "restrictions": null,
        "allow_force_pushes": false,
        "allow_deletions": false,
        "required_conversation_resolution": true
      }
      "
    `);
  });
});

describe("task issue form", () => {
  it("contains every task-spec field", () => {
    const formFile = `${repositoryRoot}/.github/ISSUE_TEMPLATE/task.yml`;
    const formText = readFileSync(formFile, "utf8");
    const form = z
      .object({
        body: z.array(
          z.object({
            attributes: z.object({
              label: z.string(),
            }),
          }),
        ),
      })
      .parse(parse(formText));

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
