// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsConfigSchema, parseYaml } from "@harness/schemas";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocTestError } from "./doc-blocks.js";
import { createDocTestTemporaryRoot, executeDocTestBlocks } from "./run-doc-tests.js";

describe("quickstart documentation test runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("identifies the second block, prints its output, stops, and attempts every cleanup", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const invoked: string[] = [];
    const markdown = [
      { kind: "run", code: "first" },
      { kind: "run", code: "fail" },
      { kind: "run", code: "skipped" },
      { kind: "cleanup", code: "cleanup one" },
      { kind: "cleanup", code: "cleanup two" },
    ]
      .flatMap(({ kind, code }) => [`<!-- test:${kind} -->`, "```bash", code, "```"])
      .join("\n");
    const expectedFailure = new DocTestError(23, "examples/crash-and-resume/README.md", 2);
    let failure: unknown;

    try {
      executeDocTestBlocks(markdown, {
        cwd: ".",
        documentPath: "examples/crash-and-resume/README.md",
        execute: (code) => {
          invoked.push(code);
          const status = code === "fail" ? 23 : 0;
          return {
            status: code === "cleanup one" ? 42 : status,
            stdout: code === "fail" ? "synthetic stdout\n" : "",
            stderr: code === "fail" ? "synthetic stderr\n" : "",
          };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DocTestError);
    expect(failure).toMatchObject({
      message: expectedFailure.message,
      documentPath: "examples/crash-and-resume/README.md",
      blockIndex: 2,
      exitCode: 23,
    });
    expect(stderr.mock.calls).toEqual([
      [`${expectedFailure.message} stdout (last 200 lines):\nsynthetic stdout\n`],
      [`${expectedFailure.message} stderr (last 200 lines):\nsynthetic stderr\n`],
    ]);
    expect(invoked).toEqual(["first", "fail", "cleanup one", "cleanup two"]);
  });

  it.each(["", "\n", "\r\n"])(
    "limits each failed output stream to its last 200 lines (%j)",
    (ending) => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const lines = Array.from(
        { length: 205 },
        (_, index) => `synthetic line ${String(index + 1)}`,
      );
      const output = `${lines.join("\n")}${ending}`;

      expect(() => {
        executeDocTestBlocks("<!-- test:run -->\n```bash\nfail\n```", {
          cwd: ".",
          execute: () => ({ status: 1, stdout: output, stderr: output }),
        });
      }).toThrow("docs/quickstart.md block 1");

      const tail = `${lines.slice(5).join("\n")}\n`;
      expect(stderr.mock.calls).toEqual([
        [
          `docs_quickstart_test_failed: docs/quickstart.md block 1 stdout (last 200 lines):\n${tail}`,
        ],
        [
          `docs_quickstart_test_failed: docs/quickstart.md block 1 stderr (last 200 lines):\n${tail}`,
        ],
      ]);
    },
  );

  it("keeps document-order indexes for cleanup failures after a prelude", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const markdown = [
      { kind: "prelude", code: "setup" },
      { kind: "run", code: "pass" },
      { kind: "cleanup", code: "fail" },
    ]
      .flatMap(({ kind, code }) => [`<!-- test:${kind} -->`, "```bash", code, "```"])
      .join("\n");

    expect(() => {
      executeDocTestBlocks(markdown, {
        cwd: ".",
        documentPath: "examples/replay/README.md",
        execute: (code) => ({
          status: code.endsWith("fail") ? 1 : 0,
          stdout: "synthetic stdout",
          stderr: "",
        }),
      });
    }).toThrow("examples/replay/README.md block 3");

    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "docs_quickstart_test_failed: examples/replay/README.md block 3 stdout (last 200 lines):\nsynthetic stdout\n",
    );
  });

  it("reports captured output and location when a capture fails", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => {
      executeDocTestBlocks(
        "<!-- test:run -->\n<!-- capture:runId=(?<runId>[A-Z]+) -->\n```bash\nrun\n```",
        {
          cwd: ".",
          execute: () => ({ status: 0, stdout: "", stderr: "synthetic missing capture" }),
        },
      );
    }).toThrow("docs/quickstart.md block 1");

    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "docs_quickstart_test_failed: docs/quickstart.md block 1 stderr (last 200 lines):\nsynthetic missing capture\n",
    );
  });

  it("preserves the contextual failure when the shell cannot start", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "quickstart-doc-test-"));
    await rm(temporaryDirectory, { recursive: true, force: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => {
      executeDocTestBlocks(
        "<!-- test:run -->\n```bash\nrun\n```\n<!-- test:cleanup -->\n```bash\ncleanup\n```",
        { cwd: temporaryDirectory },
      );
    }).toThrow(new DocTestError(1, "docs/quickstart.md", 1));
    expect(stderr).not.toHaveBeenCalled();
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
