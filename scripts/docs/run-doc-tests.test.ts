// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { executeDocTestBlocks, extractDocTestBlocks, substituteCaptures } from "./run-doc-tests.js";

describe("quickstart documentation test runner", () => {
  it("extracts marked shell blocks and their capture directives", () => {
    const markdown = [
      "```text",
      "not executed",
      "```",
      "<!-- test:run -->",
      "<!-- capture:runId=(?<runId>[A-Z]+) -->",
      "",
      "```bash",
      "echo run",
      "```",
      "<!-- test:cleanup -->",
      "```sh",
      "cleanup",
      "```",
    ].join("\n");

    expect(extractDocTestBlocks(markdown)).toEqual([
      {
        kind: "run",
        code: "echo run",
        captures: [{ name: "runId", pattern: "(?<runId>[A-Z]+)" }],
      },
      { kind: "cleanup", code: "cleanup", captures: [] },
    ]);
  });

  it("substitutes named captures and rejects missing placeholders", () => {
    expect(substituteCaptures("inspect <runId>", new Map([["runId", "RUN123"]]))).toBe(
      "inspect RUN123",
    );
    expect(() => substituteCaptures("inspect <missing>", new Map())).toThrow(
      "docs_quickstart_test_failed",
    );
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
    expect(() =>
      extractDocTestBlocks(
        ["<!-- test:run -->", "<!-- capture:runId=[ -->", "```bash", "run", "```"].join("\n"),
      ),
    ).toThrow("docs_quickstart_test_failed");

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
