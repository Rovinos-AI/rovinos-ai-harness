// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { PiiExplainResultSchema, parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { piiCommand } from "./pii.js";

const config = HarnessConfigSchema.parse({
  pii: {
    custom: [{ name: "case_id", pattern: "CASE-[A-Z]{2}[0-9]{2}" }],
    rules: [
      {
        entities: ["email"],
        boundaries: ["model_input"],
        destinations: ["local"],
        action: "allow",
      },
      {
        entities: ["email"],
        boundaries: ["tool_input"],
        destinations: [{ tool: "mail.send" }],
        action: "redact",
      },
    ],
  },
});

function createContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(config),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 0 },
  };
  return { context, stdout, stderr };
}

describe("harness pii explain", () => {
  it("explains the effective local model action and matching rule", async () => {
    const fixture = createContext();

    const code = await main(
      [
        "pii",
        "explain",
        "--boundary",
        "model_input",
        "--destination",
        "local",
        "--entity",
        "email",
      ],
      fixture.context,
      [piiCommand],
    );

    expect(code).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("model_input\tlocal\temail\ttokenize\t0");
    expect(fixture.stderr).toEqual([]);
  });

  it("prints a matrix containing built-in, custom, and configured tool destinations", async () => {
    const fixture = createContext();

    const code = await main(["pii", "explain", "--matrix"], fixture.context, [piiCommand]);

    expect(code).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("tool_input\ttool:mail.send\temail\tredact\t1");
    expect(fixture.stdout.join("")).toContain("custom_case_id");
    expect(fixture.stderr).toEqual([]);
  });

  it("emits one schema-validated JSON document in JSON mode", async () => {
    const fixture = createContext();

    const code = await main(["--json", "pii", "explain", "--matrix"], fixture.context, [
      piiCommand,
    ]);

    expect(code).toBe(ExitCode.ok);
    expect(fixture.stdout).toHaveLength(1);
    expect(parseJson(PiiExplainResultSchema, fixture.stdout[0] ?? "").mode).toBe("matrix");
    expect(fixture.stderr.join("")).toContain("boundary\tdestination\tentity\taction\trule");
  });

  it("rejects incomplete single-decision arguments with the usage code", async () => {
    const fixture = createContext();

    const code = await main(["pii", "explain"], fixture.context, [piiCommand]);

    expect(code).toBe(ExitCode.usage);
    expect(fixture.stderr).toEqual(["usage\n"]);
  });
});
