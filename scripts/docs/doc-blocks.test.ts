// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { extractDocTestBlocks, substituteCaptures } from "./doc-blocks.js";

describe("documentation test block parser", () => {
  it("extracts marked shell blocks and captures", () => {
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

  it("extracts a prelude and an expected non-zero exit code", () => {
    expect(
      extractDocTestBlocks(
        [
          "<!-- test:prelude -->",
          "```bash",
          "setup",
          "```",
          "<!-- test:expect-exit=5 -->",
          "<!-- test:run -->",
          "```bash",
          "suspend",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "prelude", code: "setup", captures: [] },
      { kind: "run", code: "suspend", captures: [], expectedExitCode: 5 },
    ]);
  });

  it("substitutes captures and rejects missing placeholders", () => {
    expect(substituteCaptures("inspect <runId>", new Map([["runId", "RUN123"]]))).toBe(
      "inspect RUN123",
    );
    expect(() => substituteCaptures("inspect <missing>", new Map())).toThrow(
      "docs_quickstart_test_failed",
    );
  });

  it("rejects invalid capture directives and expected exit codes", () => {
    expect(() =>
      extractDocTestBlocks(
        ["<!-- test:run -->", "<!-- capture:runId=[ -->", "```bash", "run", "```"].join("\n"),
      ),
    ).toThrow("docs_quickstart_test_failed");
    expect(() =>
      extractDocTestBlocks(
        ["<!-- test:run -->", "<!-- test:expect-exit=256 -->", "```bash", "run", "```"].join("\n"),
      ),
    ).toThrow("docs_quickstart_test_failed");
  });
});
