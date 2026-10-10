// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@harness/schemas";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext, CommandModule } from "./command.js";
import { ERROR_EXIT_CODES, errorCodeOf, ExitCode, exitCodeForError } from "./exit-codes.js";
import { createOutput } from "./output.js";
import { COMMANDS, main } from "./main.js";

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = createOutput({
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });
  const context: CliContext = {
    loadConfig: () => Promise.reject(new Error("Configuration not needed in this test.")),
    out,
    clock: { now: () => 1_000 },
  };
  return { context, stdout, stderr };
}

const resultSchema = z.object({ ok: z.boolean() }).strict();

const sampleCommand: CommandModule = {
  name: "sample",
  register(program, ctx) {
    program
      .command("sample")
      .description("sample command for tests")
      .action(() => {
        ctx.out.print("human output\n");
        ctx.out.json(resultSchema, { ok: true });
      });
  },
};

async function sourceFilesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFilesIn(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI main", () => {
  it("lists registered commands and global flags in help", async () => {
    const { context, stdout } = createContext();

    const code = await main(["--help"], context, [sampleCommand]);

    expect(code).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("sample");
    expect(stdout.join("")).toContain("--config");
    expect(stdout.join("")).toContain("--json");
    expect(stdout.join("")).toContain("--log-level");
  });

  it("emits one parseable JSON document and sends human text to stderr", async () => {
    const { context, stdout, stderr } = createContext();

    const code = await main(["--json", "sample"], context, [sampleCommand]);
    const documents = stdout.join("").trim().split("\n");

    expect(code).toBe(ExitCode.ok);
    expect(documents).toHaveLength(1);
    expect(parseJson(resultSchema, documents[0] ?? "")).toEqual({ ok: true });
    expect(stderr).toEqual(["human output\n"]);
  });

  it("shows human output only when JSON mode is disabled", async () => {
    const { context, stdout, stderr } = createContext();

    const code = await main(["sample"], context, [sampleCommand]);

    expect(code).toBe(ExitCode.ok);
    expect(stdout).toEqual(["human output\n"]);
    expect(stderr).toEqual([]);
  });

  it("fails JSON mode when the command writes no JSON document", async () => {
    const { context, stdout, stderr } = createContext();
    const command: CommandModule = {
      name: "silent",
      register(program) {
        program.command("silent").action(() => undefined);
      },
    };

    const code = await main(["--json", "silent"], context, [command]);

    expect(code).toBe(ExitCode.failure);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["output_invalid\n"]);
  });

  it("fails JSON mode when a command attempts two documents", async () => {
    const { context, stdout, stderr } = createContext();
    const command: CommandModule = {
      name: "duplicate",
      register(program, ctx) {
        program.command("duplicate").action(() => {
          ctx.out.json(resultSchema, { ok: true });
          ctx.out.json(resultSchema, { ok: true });
        });
      },
    };

    const code = await main(["--json", "duplicate"], context, [command]);

    expect(code).toBe(ExitCode.failure);
    expect(stdout).toEqual(['{"ok":true}\n']);
    expect(stderr).toEqual(["json_output_multiple\n"]);
  });

  it("shows help and returns the usage exit code for unknown commands", async () => {
    const { context, stdout, stderr } = createContext();

    const code = await main(["missing"], context, [sampleCommand]);

    expect(code).toBe(ExitCode.usage);
    expect(stdout.join("")).toContain("sample");
    expect(stderr).toEqual(["usage\n"]);
  });

  it("returns usage for invalid options without printing Commander messages", async () => {
    const { context, stderr } = createContext();

    const code = await main(["--invalid"], context, [sampleCommand]);

    expect(code).toBe(ExitCode.usage);
    expect(stderr).toEqual(["usage\n"]);
  });

  it("maps the built-in version option through the output boundary", async () => {
    const { context, stdout } = createContext();

    const code = await main(["--version"], context, []);

    expect(code).toBe(ExitCode.ok);
    expect(stdout).toEqual(["0.0.0\n"]);
  });

  it.each(Object.entries(ERROR_EXIT_CODES))("maps %s to exit code %i", (errorCode, expected) => {
    expect(exitCodeForError(errorCode)).toBe(expected);
  });

  it("maps budget_exceeded to exit code 6", () => {
    expect(exitCodeForError("budget_exceeded")).toBe(6);
  });

  it("uses failure for unmapped and invalid error codes", () => {
    expect(exitCodeForError("unmapped_error")).toBe(ExitCode.failure);
    expect(errorCodeOf(new Error("private message"))).toBe("failure");
    expect(errorCodeOf({ code: "private message" })).toBe("failure");
  });

  it("prints only an error code and returns its mapped exit code", async () => {
    const { context, stderr } = createContext();
    const command: CommandModule = {
      name: "fail",
      register(program) {
        program.command("fail").action(() => {
          throw Object.assign(new Error("must not be printed"), { code: "config_invalid" });
        });
      },
    };

    const code = await main(["fail"], context, [command]);

    expect(code).toBe(ExitCode.configInvalid);
    expect(stderr).toEqual(["config_invalid\n"]);
  });

  it("uses the static command registry by default", async () => {
    const { context, stdout } = createContext();

    const code = await main([], context);

    expect(COMMANDS.map((command) => command.name)).toEqual([
      "serve",
      "run",
      "resume",
      "inspect",
      "cancel",
      "context",
    ]);
    expect(code).toBe(ExitCode.ok);
    expect(stdout.join("")).toContain("Usage: harness");
    expect(stdout.join("")).toContain("serve");
  });

  it("keeps standard stream writes in output.ts only", async () => {
    const srcDirectory = fileURLToPath(new URL(".", import.meta.url));
    const forbiddenReference = ["process", "stdout"].join(".");
    const files = await sourceFilesIn(srcDirectory);
    const sourceText = await Promise.all(files.map((path) => readFile(path, "utf8")));
    const violations = files.filter(
      (path, index) =>
        !path.endsWith("/output.ts") && (sourceText[index]?.includes(forbiddenReference) ?? false),
    );

    expect(violations).toEqual([]);
  });
});
