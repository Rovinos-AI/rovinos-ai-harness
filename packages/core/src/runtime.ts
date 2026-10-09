// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  context as otelContext,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { HarnessError, Id, Sha256Hex, type JsonValue, type RunConfig } from "@harness/schemas";
import { SqliteEventStore, type EventStore } from "@harness/store";
import { NaiveContext } from "./context/naive-context.js";
import type { ContextPort, IdGenerator, ModelPort, ToolPort } from "./ports.js";
import { resumeRun } from "./resume.js";
import type { Clock } from "./recorder.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import { RunRecorder } from "./recorder.js";
import { runLoop, type RunLoopResult } from "./loop.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const POLICY_VERSION = "unconfigured";

function randomHex(byteLength: number): string {
  let value = randomBytes(byteLength).toString("hex");
  while (value === "0".repeat(byteLength * 2)) {
    value = randomBytes(byteLength).toString("hex");
  }
  return value;
}

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

class RuntimeSpan implements Span {
  private ended = false;
  private readonly value: SpanContext;

  constructor(traceId: string) {
    this.value = {
      traceId,
      spanId: randomHex(8),
      traceFlags: 1,
    };
  }

  spanContext(): SpanContext {
    return this.value;
  }

  setAttribute(_key: string, _value: string | number | boolean): this {
    return this;
  }

  setAttributes(_attributes: SpanOptions["attributes"]): this {
    return this;
  }

  addEvent(
    _name: Parameters<Span["addEvent"]>[0],
    _attributesOrStartTime?: Parameters<Span["addEvent"]>[1],
    _startTime?: Parameters<Span["addEvent"]>[2],
  ): this {
    return this;
  }

  addLink(_link: Parameters<Span["addLink"]>[0]): this {
    return this;
  }

  addLinks(_links: Parameters<Span["addLinks"]>[0]): this {
    return this;
  }

  setStatus(_status: Parameters<Span["setStatus"]>[0]): this {
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(): void {
    this.ended = true;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(
    _exception: Parameters<Span["recordException"]>[0],
    _time?: Parameters<Span["recordException"]>[1],
  ): void {}
}

class RuntimeTracer implements Tracer {
  startSpan(_name: string, options?: SpanOptions, parentContext?: Context): Span {
    const parent = trace.getSpan(parentContext ?? otelContext.active())?.spanContext();
    const traceId = parent?.traceId ?? randomHex(16);
    return new RuntimeSpan(traceId);
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    activeContext: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    _name: string,
    _optionsOrCallback: SpanOptions | F,
    _contextOrCallback?: Context | F,
    _callback?: F,
  ): ReturnType<F> {
    throw new Error("The runtime fallback tracer supports registered spans only.");
  }
}

class RuntimeTracerProvider implements TracerProvider {
  private readonly tracer = new RuntimeTracer();

  getTracer(): Tracer {
    return this.tracer;
  }
}

class RuntimeContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_activeContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

function ensureTracing(): void {
  otelContext.setGlobalContextManager(new RuntimeContextManager());
  trace.setGlobalTracerProvider(new RuntimeTracerProvider());
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

class UnconfiguredModelError extends HarnessError {
  readonly code = "model_not_configured";

  constructor() {
    super("No model port is configured.");
  }
}

class UnconfiguredToolError extends HarnessError {
  readonly code = "tool_not_configured";

  constructor() {
    super("No tool port is configured.");
  }
}

const unconfiguredModel: ModelPort = {
  complete: () => Promise.reject(new UnconfiguredModelError()),
};

const unavailableTool: ToolPort = {
  describe: () => undefined,
  execute: () => Promise.reject(new UnconfiguredToolError()),
};

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
  exit: (code) => process.exit(code),
};

function configHash(config: RuntimeConfig): ReturnType<typeof Sha256Hex.parse> {
  return Sha256Hex.parse(createHash("sha256").update(JSON.stringify(config)).digest("hex"));
}

async function storedGoal(store: EventStore, runId: Id): Promise<JsonValue> {
  let goal: JsonValue = null;
  for await (const event of store.read(runId)) {
    if (
      event.type === "model_request" &&
      typeof event.messages === "object" &&
      event.messages !== null &&
      !Array.isArray(event.messages) &&
      Object.hasOwn(event.messages, "goal")
    ) {
      goal = event.messages.goal ?? null;
    }
  }
  return goal;
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
  const store =
    overrides.store ??
    (await (async () => {
      await mkdir(dataDir, { recursive: true });
      return new SqliteEventStore(join(dataDir, "harness.db"));
    })());
  const model = overrides.model ?? unconfiguredModel;
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
        storedGoal(store, runId).then((goal) =>
          resumeRun({
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
          }),
        ),
      ),
    close: () => store.close(),
  };
}
