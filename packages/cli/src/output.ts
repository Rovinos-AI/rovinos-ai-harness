// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError } from "@rovinos/schemas";
import type { z } from "zod";

/** Output destinations used by the CLI; injectable for tests. */
export interface OutputWriters {
  /** Writes text to the standard output destination. */
  stdout(text: string): void;
  /** Writes text to the standard error destination. */
  stderr(text: string): void;
}

/** Output operations available to CLI commands. */
export interface Output {
  /** Routes human-readable output according to the selected output mode. */
  print(text: string): void;
  /** Renders rows as tab-separated human-readable text. */
  table(rows: readonly (readonly (string | number | boolean)[])[]): void;
  /** Validates a command result and writes one JSON document to stdout. */
  json(schema: z.ZodType, value: unknown): void;
  /** Writes a safe error code and optional safe hint to stderr. */
  error(code: string, hint?: string): void;
  /** Sets the output mode before parsing or executing a command. */
  setJsonMode(enabled: boolean): void;
  /** Verifies that JSON mode produced exactly one document. */
  finalize(): void;
}

/** Safe error raised when a JSON result is invalid or a second document is attempted. */
export class OutputError extends HarnessError {
  /** Machine-readable error code. */
  override readonly code: string;

  /**
   * Creates a value-free output error.
   *
   * @param code - The safe output failure code.
   */
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function serializeJson(value: unknown): string {
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new OutputError("output_invalid");
  }
  return serialized;
}

const defaultWriters: OutputWriters = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Creates the only CLI writer for standard output and error.
 *
 * @param writers - Optional output sinks, primarily for deterministic tests.
 * @returns Output operations whose JSON mode keeps human text off stdout.
 */
export function createOutput(writers: OutputWriters = defaultWriters): Output {
  let jsonMode = false;
  let jsonDocuments = 0;
  const print = (text: string): void => {
    if (jsonMode) {
      writers.stderr(text);
    } else {
      writers.stdout(text);
    }
  };

  return {
    print,
    table: (rows) => {
      if (rows.length === 0) {
        return;
      }
      print(`${rows.map((row) => row.join("\t")).join("\n")}\n`);
    },
    json: (schema, value) => {
      if (!jsonMode) {
        return;
      }
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new OutputError("output_invalid");
      }
      const serialized = serializeJson(result.data);
      if (jsonDocuments > 0) {
        throw new OutputError("json_output_multiple");
      }
      jsonDocuments += 1;
      writers.stdout(`${serialized}\n`);
    },
    error: (code, hint) => {
      const parsedCode = Code.safeParse(code);
      const safeCode = parsedCode.success ? parsedCode.data : "failure";
      const parsedHint = hint === undefined ? undefined : Code.safeParse(hint);
      const safeHint = parsedHint?.success === true ? ` ${parsedHint.data}` : "";
      writers.stderr(`${safeCode}${safeHint}\n`);
    },
    finalize: () => {
      if (jsonMode && jsonDocuments !== 1) {
        throw new OutputError("output_invalid");
      }
    },
    setJsonMode: (enabled) => {
      jsonMode = enabled;
      jsonDocuments = 0;
    },
  };
}
