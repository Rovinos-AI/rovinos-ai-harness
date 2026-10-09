// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createContextKey,
  isSpanContextValid,
  context as otelContext,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { HarnessError, Id, Sha256Hex, type JsonValue, type RunConfig } from "@harness/schemas";
import { SqliteEventStore, type EventStore } from "@harness/store";
import { NaiveContext } from "./context/naive-context.js";
import type { ContextPort, IdGenerator, ModelPort, ToolPort } from "./ports.js";
import { resumeRun } from "./resume.js";
import type { Clock } from "./recorder.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import { RunRecorder } from "./recorder.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { RUN_SPAN } from "./spans.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const POLICY_VERSION = "default";
const CONTEXT_PROBE_KEY = createContextKey("harness.runtime.context-probe");
let fallbackTracerInstalled = false;

/** Runtime dependencies that can be replaced by tests or embedding applications. */
export interface RuntimeOverrides {
  readonly store?: EventStore;
  readonly dataDir?: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly model?: ModelPort;
  readonly tool?: ToolPort;
  readonly context?: ContextPort;
  readonly processLike?: ShutdownProcessLike;
}

/** Runtime configuration required by the currently implemented run loop. */
export interface RuntimeConfig {
  readonly run: RunConfig;
}

/** Composed run-loop operations and their shared dependencies. */
export interface Runtime {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  run(goal: JsonValue): Promise<RunLoopResult>;
  resume(runId: Id): Promise<RunLoopResult>;
  close(): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now() };

function hasContextPropagation(): boolean {
  const marker = {};
  let propagated = false;
  otelContext.with(ROOT_CONTEXT.setValue(CONTEXT_PROBE_KEY, marker), () => {
    propagated = otelContext.active().getValue(CONTEXT_PROBE_KEY) === marker;
  });
  return propagated;
}

function ensureTracing(): void {
  const probeIds = new SystemIdGenerator(systemClock);
  const probe = RUN_SPAN.start({
    "harness.run.id": probeIds.next(),
    "harness.segment.id": probeIds.next(),
  });
  const tracerIsValid = isSpanContextValid(probe.spanContext());
  probe.end();
  if (!tracerIsValid && !fallbackTracerInstalled) {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    fallbackTracerInstalled = true;
  }
  if (!hasContextPropagation()) {
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  }
}

class SystemIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock) {}

  next(): Id {
    const timestamp = BigInt(Math.max(0, Math.floor(this.clock.now())));
    const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
    let value = (timestamp << 80n) | random;
    let encoded = "";
    for (let index = 0; index < 26; index += 1) {
      encoded = `${ULID_ALPHABET[Number(value & 31n)] ?? "0"}${encoded}`;
      value >>= 5n;
    }
    return Id.parse(encoded);
  }
}

class ModelNotConfiguredError extends HarnessError {
  readonly code = "model_not_configured";

  constructor() {
    super("No model port is configured.");
  }
}

class ToolNotConfiguredError extends HarnessError {
  readonly code = "tool_not_configured";

  constructor() {
    super("No tool port is configured.");
  }
}

const missingModelPort: ModelPort = {
  complete: () => Promise.reject(new ModelNotConfiguredError()),
};

const unavailableTool: ToolPort = {
  describe: () => undefined,
  execute: () => Promise.reject(new ToolNotConfiguredError()),
};

class RunInputMissingError extends HarnessError {
  readonly code = "run_input_missing";

  constructor() {
    super("The run input is unavailable.");
  }
}

const defaultProcessLike: ShutdownProcessLike = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  get exitCode(): number | undefined {
    return typeof process.exitCode === "number" ? process.exitCode : undefined;
  },
  set exitCode(code) {
    if (code !== undefined) {
      process.exitCode = code;
    }
  },
  // The shutdown grace deadline must force termination if the active operation does not flush.
  // eslint-disable-next-line n/no-process-exit -- shutdown deadline is the final safety bound
  exit: (code) => process.exit(code),
};

function configHash(config: RuntimeConfig): ReturnType<typeof Sha256Hex.parse> {
  return Sha256Hex.parse(createHash("sha256").update(JSON.stringify(config)).digest("hex"));
}

async function storedGoal(store: EventStore, runId: Id): Promise<JsonValue | undefined> {
  for await (const event of store.read(runId)) {
    if (
      event.type === "model_request" &&
      typeof event.messages === "object" &&
      event.messages !== null &&
      !Array.isArray(event.messages) &&
      Object.hasOwn(event.messages, "goal")
    ) {
      return event.messages.goal ?? null;
    }
  }
  return undefined;
}

async function createSqliteStore(dataDir: string): Promise<EventStore> {
  await mkdir(dataDir, { recursive: true });
  return new SqliteEventStore(join(dataDir, "harness.db"));
}

/**
 * Builds a runtime from validated configuration. Until the provider-owning
 * epics land, model and tool ports must be supplied through overrides.
 *
 * @param config - Validated harness configuration with run-loop settings.
 * @param overrides - Optional stores, ports, and deterministic test dependencies.
 * @returns Run, resume, and store operations sharing the composed dependencies.
 */
export async function createRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  ensureTracing();
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? new SystemIdGenerator(clock);
  const dataDir = overrides.dataDir ?? process.env.HARNESS_DATA_DIR ?? process.cwd();
  const store = overrides.store ?? (await createSqliteStore(dataDir));
  const model = overrides.model ?? missingModelPort;
  const tool = overrides.tool ?? unavailableTool;
  const context = overrides.context ?? new NaiveContext();
  const withShutdown = async <Result>(
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> => {
    const controller = new AbortController();
    let running: Promise<Result> | undefined;
    const uninstall = installShutdownHandler({
      processLike: overrides.processLike ?? defaultProcessLike,
      controller,
      graceMs: config.run.shutdownGraceMs,
      onTimeout: async () => {
        await running;
      },
    });
    try {
      running = operation(controller.signal);
      return await running;
    } finally {
      uninstall();
    }
  };

  return {
    store,
    clock,
    ids,
    run: (goal) =>
      withShutdown(async (signal) => {
        const runId = ids.next();
        const recorder = new RunRecorder(store, runId, ids.next(), 0, clock);
        return runLoop({
          recorder,
          clock,
          model,
          tool,
          context,
          ids,
          goal,
          signal,
          budgets: config.run.budgets,
          checkpointEveryEvents: config.run.checkpointEveryEvents,
          configHash: configHash(config),
          policyVersion: POLICY_VERSION,
        });
      }),
    resume: (runId) =>
      withShutdown((signal) =>
        storedGoal(store, runId).then((goal) => {
          if (goal === undefined) {
            // TODO(15.1): A durable run_input event will make this interruption resumable.
            throw new RunInputMissingError();
          }
          return resumeRun({
            store,
            runId,
            clock,
            ids,
            goal,
            model,
            tool,
            context,
            signal,
            budgets: config.run.budgets,
            checkpointEveryEvents: config.run.checkpointEveryEvents,
            resumePolicy: config.run.resume.onNonIdempotent,
          });
        }),
      ),
    close: () => store.close(),
  };
}
