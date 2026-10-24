// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsConfigSchema, parseYaml } from "@rovinos/schemas";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createDocTestTemporaryRoot, executeDocTestBlocks } from "./run-doc-tests.js";

describe("quickstart documentation test runner", () => {
  it("creates the temporary parent when it is missing", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quickstart-doc-test-"));
    const missingParent = join(temporaryDirectory, ".tmp");

    try {
      const created = await createDocTestTemporaryRoot(missingParent);

      expect((await stat(missingParent)).isDirectory()).toBe(true);
      expect(created.startsWith(`${missingParent}/quickstart-doc-tests-`)).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("validates the documented real-provider example against the models config schema", async () => {
    const markdown = await readFile(new URL("../../docs/quickstart.md", import.meta.url), "utf8");
    const providerExample = /## Using a real provider[\s\S]*?```yaml\n([\s\S]*?)\n```/u.exec(
      markdown,
    )?.[1];
    if (providerExample === undefined) {
      throw new Error("quickstart_provider_example_missing");
    }

    const parsed = parseYaml(z.object({ models: ModelsConfigSchema }).strict(), providerExample);
    expect(parsed.models.providers).toMatchObject([
      { id: "openai", kind: "openai", apiKey: "env:OPENAI_API_KEY" },
    ]);
    expect(parsed.models.routing.default).toEqual([{ provider: "openai", model: "gpt-4o-mini" }]);
  });

  it("uses a named capture from one block in the next block", () => {
    const invoked: string[] = [];
    executeDocTestBlocks(
      [
        "<!-- test:run -->",
        "<!-- capture:runId=run=(?<runId>[A-Z0-9]+) -->",
        "```bash",
        "emit run=RUN123",
        "```",
        "<!-- test:run -->",
        "```bash",
        "inspect <runId>",
        "```",
      ].join("\n"),
      {
        cwd: ".",
        execute: (code) => {
          invoked.push(code);
          return { status: 0, stdout: code.includes("emit") ? "run=RUN123" : "", stderr: "" };
        },
      },
    );

    expect(invoked).toEqual(["emit run=RUN123", "inspect RUN123"]);
  });

  it("prepends the prelude and accepts a matching expected exit code", () => {
    const invoked: string[] = [];

    executeDocTestBlocks(
      [
        "<!-- test:prelude -->",
        "```bash",
        "helper setup",
        "```",
        "<!-- test:expect-exit=5 -->",
        "<!-- test:run -->",
        "```bash",
        "suspend",
        "```",
        "<!-- test:cleanup -->",
        "```bash",
        "cleanup",
        "```",
      ].join("\n"),
      {
        cwd: ".",
        execute: (code) => {
          invoked.push(code);
          return { status: code.endsWith("suspend") ? 5 : 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(invoked).toEqual(["helper setup\nsuspend", "helper setup\ncleanup"]);
  });

  it("fails on an unexpected exit code and still runs cleanup", () => {
    const invoked: string[] = [];

    expect(() => {
      executeDocTestBlocks(
        [
          "<!-- test:expect-exit=5 -->",
          "<!-- test:run -->",
          "```bash",
          "run",
          "```",
          "<!-- test:cleanup -->",
          "```bash",
          "cleanup",
          "```",
        ].join("\n"),
        {
          cwd: ".",
          execute: (code) => {
            invoked.push(code);
            return { status: code === "run" ? 4 : 0, stdout: "", stderr: "" };
          },
        },
      );
    }).toThrow("docs_quickstart_test_failed");
    expect(invoked).toEqual(["run", "cleanup"]);
  });

  it("runs every cleanup block after a command fails and preserves the exit code", () => {
    const invoked: string[] = [];
    let failure: unknown;

    try {
      executeDocTestBlocks(
        [
          "<!-- test:run -->",
          "```bash",
          "fail",
          "```",
          "<!-- test:cleanup -->",
          "```bash",
          "cleanup one",
          "```",
          "<!-- test:cleanup -->",
          "```bash",
          "cleanup two",
          "```",
        ].join("\n"),
        {
          cwd: ".",
          execute: (code) => {
            invoked.push(code);
            return { status: code === "fail" ? 23 : 0, stdout: "", stderr: "" };
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ exitCode: 23 });
    expect(invoked).toEqual(["fail", "cleanup one", "cleanup two"]);
  });

  it("fails when a capture pattern is invalid or does not match", () => {
    expect(() => {
      executeDocTestBlocks(
        [
          "<!-- test:run -->",
          "<!-- capture:runId=(?<runId>[A-Z]+) -->",
          "```bash",
          "run",
          "```",
        ].join("\n"),
        { cwd: ".", execute: () => ({ status: 0, stdout: "", stderr: "" }) },
      );
    }).toThrow("docs_quickstart_test_failed");
  });
});
