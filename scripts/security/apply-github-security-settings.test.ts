// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@rovinos/schemas";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = `${root}/scripts/security/apply-github-security-settings.sh`;
const settingsRequestSchema = z
  .object({
    method: z.enum(["PATCH", "PUT"]),
    endpoint: z.string(),
    payload: z
      .object({
        security_and_analysis: z
          .object({
            secret_scanning: z.object({ status: z.literal("enabled") }).strict(),
            secret_scanning_push_protection: z.object({ status: z.literal("enabled") }).strict(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const dryRunSchema = z.object({ requests: z.array(settingsRequestSchema).length(4) }).strict();

describe("apply-github-security-settings.sh", () => {
  it("prints the security settings requests without calling GitHub", () => {
    const result = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = parseJson(dryRunSchema, result.stdout);
    expect(output.requests).toEqual([
      {
        method: "PATCH",
        endpoint: "repos/{owner}/{repo}",
        payload: {
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
          },
        },
      },
      { method: "PUT", endpoint: "repos/{owner}/{repo}/vulnerability-alerts", payload: null },
      {
        method: "PUT",
        endpoint: "repos/{owner}/{repo}/automated-security-fixes",
        payload: null,
      },
      {
        method: "PUT",
        endpoint: "repos/{owner}/{repo}/private-vulnerability-reporting",
        payload: null,
      },
    ]);
  });

  it("applies all four settings through the correct GitHub endpoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "github-security-settings-"));
    const calls = join(directory, "calls");
    try {
      writeFileSync(
        join(directory, "gh"),
        '#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\nprintf \'%s\\n\' "$*" >> "$GH_CALLS"\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", [script, "--apply"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, GH_CALLS: calls },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "api -X PATCH repos/{owner}/{repo} --input -",
        "api -X PUT repos/{owner}/{repo}/vulnerability-alerts",
        "api -X PUT repos/{owner}/{repo}/automated-security-fixes",
        "api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an explicit mode and rejects unknown arguments", () => {
    const missingMode = spawnSync("bash", [script], { encoding: "utf8" });
    const unknownMode = spawnSync("bash", [script, "--unknown"], { encoding: "utf8" });

    expect(missingMode.status).toBe(2);
    expect(missingMode.stdout).toBe("");
    expect(missingMode.stderr).toContain("Usage:");
    expect(unknownMode.status).toBe(2);
    expect(unknownMode.stdout).toBe("");
    expect(unknownMode.stderr).toContain("Usage:");
  });
});
