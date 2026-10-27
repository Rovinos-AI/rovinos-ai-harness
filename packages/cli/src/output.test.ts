// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createOutput } from "./output.js";

function captureOutput() {
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
  return { out, stdout, stderr };
}

describe("CLI output", () => {
  it("routes human text and tables to stdout by default", () => {
    const { out, stdout } = captureOutput();

    out.print("plain\n");
    out.table([
      ["id", "status"],
      ["run-1", "ok"],
    ]);

    expect(stdout).toEqual(["plain\n", "id\tstatus\nrun-1\tok\n"]);
  });

  it("routes human text to stderr in JSON mode", () => {
    const { out, stdout, stderr } = captureOutput();

    out.setJsonMode(true);
    out.print("human-only\n");
    out.table([["id"]]);

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["human-only\n", "id\n"]);
  });

  it("validates and writes exactly one JSON document", () => {
    const { out, stdout } = captureOutput();
    const schema = z.object({ ok: z.boolean() }).strict();

    out.setJsonMode(true);
    out.json(schema, { ok: true });
    out.finalize();

    expect(stdout).toEqual(['{"ok":true}\n']);
    expect(() => {
      out.json(schema, { ok: true });
    }).toThrow("json_output_multiple");
    expect(() => {
      out.json(schema, { ok: "not a boolean" });
    }).toThrow("output_invalid");
  });

  it("rejects JSON mode when no document was written", () => {
    const { out } = captureOutput();

    out.setJsonMode(true);

    expect(() => {
      out.finalize();
    }).toThrow("output_invalid");
  });

  it("does not write JSON in human mode", () => {
    const { out, stdout } = captureOutput();

    out.print("human output\n");
    out.json(z.object({ ok: z.boolean() }), { ok: true });
    out.finalize();

    expect(stdout).toEqual(["human output\n"]);
  });

  it("does not print validation details and rejects non-code errors", () => {
    const { out, stderr } = captureOutput();
    const schema = z.object({ status: z.literal("ok") });

    out.setJsonMode(true);
    expect(() => {
      out.json(schema, { status: "private detail" });
    }).toThrow("output_invalid");
    out.error("policy_denied", "approval_required");
    out.error("private error message");
    out.error("failure", "private hint");

    expect(stderr).toEqual(["policy_denied approval_required\n", "failure\n", "failure\n"]);
  });

  it("rejects values that cannot be represented as a JSON document", () => {
    const { out, stdout } = captureOutput();

    out.setJsonMode(true);
    expect(() => {
      out.json(z.undefined(), undefined);
    }).toThrow("output_invalid");
    expect(stdout).toEqual([]);
  });

  it("does not write an empty table", () => {
    const { out, stdout } = captureOutput();

    out.table([]);

    expect(stdout).toEqual([]);
  });
});
