// SPDX-License-Identifier: Apache-2.0
import { Code, Id, parseJson } from "@rovinos/schemas";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Writable } from "node:stream";
import { z } from "zod";
import type { Code as CodeType } from "@rovinos/schemas";
import {
  createLogger,
  NoopLogger,
  type Logger,
  type LogFields,
} from "./logger.js";
import { __getLoggerDroppedFieldsForTests } from "./testing.js";

const LogValueSchema = z.union([Id, Code, z.number().int(), z.boolean()]);
const LogLineSchema = z
  .object({
    event: Code,
    fields: z.record(Code, LogValueSchema),
  })
  .loose();

expectTypeOf<Parameters<Logger["info"]>>().toEqualTypeOf<
  [event: CodeType, fields?: LogFields]
>();

function createCapture(): { readonly destination: Writable; readonly lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    },
  });
  return { destination, lines };
}

function parseLines(lines: readonly string[]) {
  return lines.map((line) => parseJson(LogLineSchema, line));
}

describe("sanctioned logger", () => {
  it("writes validated fields as JSON lines without a message", () => {
    const capture = createCapture();
    const logger = createLogger({ level: "debug", destination: capture.destination });

    logger.info("run_started", { run_id: "00000000000000000000000000", step_count: 2 });

    const [record] = parseLines(capture.lines);
    expect(record).toMatchObject({
      event: "run_started",
      fields: { run_id: "00000000000000000000000000", step_count: 2 },
    });
    expect(record).not.toHaveProperty("msg");
    expect(capture.lines[0]).toMatch(/^\{.*\}\n$/u);
  });

  it("drops and counts free-text or invalid-key fields", () => {
    const capture = createCapture();
    const logger = createLogger({ level: "debug", destination: capture.destination });

    logger.info("run_started", {
      safe_code: "step_done",
      free_text: "unstructured message",
      "invalid key": 1,
    });

    expect(parseLines(capture.lines)[0]?.fields).toEqual({ safe_code: "step_done" });
    expect(__getLoggerDroppedFieldsForTests(logger)).toBe(2);
  });

  it("filters records below the configured level", () => {
    const capture = createCapture();
    const logger = createLogger({ level: "warn", destination: capture.destination });

    logger.debug("debug_event");
    logger.info("info_event");
    logger.warn("warn_event");
    logger.error("error_event");

    expect(parseLines(capture.lines).map(({ event }) => event)).toEqual([
      "warn_event",
      "error_event",
    ]);
  });

  it("merges child bindings with per-event fields", () => {
    const capture = createCapture();
    const logger = createLogger({ level: "info", destination: capture.destination });

    logger.child({ run_id: "00000000000000000000000000", step: 1 }).info("step_started", {
      step: 2,
    });

    expect(parseLines(capture.lines)[0]?.fields).toEqual({
      run_id: "00000000000000000000000000",
      step: 2,
    });
  });

  it("provides a logger that discards events", () => {
    const logger = new NoopLogger();

    expect(() => {
      logger.child({ scope: "test" }).info("ignored_event");
    }).not.toThrow();
  });
});
