// SPDX-License-Identifier: Apache-2.0
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { LoggerProvider, LogRecord } from "@opentelemetry/api-logs";
import { createTestSpanCollector } from "@rovinos/telemetry/testing";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CanarySink } from "./canary.js";

interface ProcessOutput {
  readonly stdout: string[];
  readonly stderr: string[];
}

const logsByDbPath = new Map<string, readonly CanarySink[]>();
const spanCollector = createTestSpanCollector();
const logRecords: { readonly name: string; readonly record: LogRecord }[] = [];
const memoryLoggerProvider: LoggerProvider = {
  getLogger: (name) => ({
    enabled: () => true,
    emit: (record) => {
      logRecords.push({ name, record });
    },
  }),
};
const processOutput = new AsyncLocalStorage<ProcessOutput>();
let memoryPipelineInstalled = false;
let processOutputCaptureInstalled = false;

function interceptOutput(stream: NodeJS.WriteStream, name: "stdout" | "stderr"): void {
  const original = stream.write.bind(stream);
  Object.defineProperty(stream, "write", {
    configurable: true,
    writable: true,
    value: (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const current = processOutput.getStore();
      if (current !== undefined) {
        const text =
          typeof chunk === "string"
            ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8").toString("utf8")
            : Buffer.from(chunk).toString("utf8");
        current[name].push(text);
        const done = typeof encoding === "function" ? encoding : callback;
        if (done !== undefined) {
          queueMicrotask(() => {
            done();
          });
        }
        return true;
      }
      if (typeof encoding === "function") {
        return original(chunk, encoding);
      }
      if (encoding === undefined) {
        return callback === undefined ? original(chunk) : original(chunk, callback);
      }
      return callback === undefined ? original(chunk, encoding) : original(chunk, encoding, callback);
    },
  });
}

function installProcessOutputCapture(): void {
  if (processOutputCaptureInstalled) {
    return;
  }
  interceptOutput(process.stdout, "stdout");
  interceptOutput(process.stderr, "stderr");
  processOutputCaptureInstalled = true;
}

/** Capture stdout/stderr in async context while preserving normal process output. */
export async function captureProcessOutput<Result>(
  operation: () => Promise<Result>,
  onCaptured: (stdout: string, stderr: string) => void,
): Promise<{ readonly result: Result; readonly stdout: string; readonly stderr: string }> {
  installProcessOutputCapture();
  const capture: ProcessOutput = { stdout: [], stderr: [] };
  try {
    const result = await processOutput.run(capture, operation);
    return {
      result,
      stdout: capture.stdout.join(""),
      stderr: capture.stderr.join(""),
    };
  } finally {
    onCaptured(capture.stdout.join(""), capture.stderr.join(""));
  }
}

/** Install the eval-only in-memory provider unless an explicit external pipeline is requested. */
export function configureEvalTelemetry(exportTelemetry = false): "memory" | "caller_managed" {
  if (exportTelemetry || memoryPipelineInstalled) {
    return exportTelemetry ? "caller_managed" : "memory";
  }
  trace.disable();
  trace.setGlobalTracerProvider(spanCollector.provider);
  logs.disable();
  logs.setGlobalLoggerProvider(memoryLoggerProvider);
  memoryPipelineInstalled = true;
  return "memory";
}

function serializedSpan(span: ReturnType<typeof spanCollector.getFinishedSpans>[number]): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    events: span.events.map(({ name, attributes }) => ({ name, attributes })),
    status: span.status,
  });
}

/** Return all captured span records; unattributed records are deliberately included. */
export function evalTelemetrySinks(): CanarySink[] {
  const spans = spanCollector.getFinishedSpans().map((span, index) => ({
    name: `in-memory-span-${String(index)}`,
    content: serializedSpan(span),
  }));
  const logs = logRecords.map(({ name, record }, index) => {
    try {
      return {
        name: `in-memory-log-${String(index)}`,
        content: JSON.stringify({
          logger: name,
          eventName: record.eventName,
          timestamp: record.timestamp,
          severityText: record.severityText,
          body: record.body,
          attributes: record.attributes,
          exception:
            record.exception instanceof Error
              ? {
                  name: record.exception.name,
                  message: record.exception.message,
                  stack: record.exception.stack,
                }
              : record.exception,
        }),
      };
    } catch {
      return { name: `in-memory-log-invalid-${String(index)}`, content: "serialization_failed" };
    }
  });
  return [...spans, ...logs];
}

/** Retain trial process output without adding raw content to persisted trial results. */
export function setTrialProcessOutput(dbPath: string, stdout: string, stderr: string): void {
  logsByDbPath.set(dbPath, [
    { name: "stdout", content: stdout },
    { name: "stderr", content: stderr },
  ]);
}

/** Return captured output sinks for a trial without exposing them in result serialization. */
export function trialLogSinks(dbPath: string): readonly CanarySink[] {
  return logsByDbPath.get(dbPath) ?? [];
}
