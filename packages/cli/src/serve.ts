// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  JsonValue,
  ServeResultSchema,
  type Id,
  type RunStatus,
} from "@rovinos/schemas";
import type { ControlPlaneOperations } from "@rovinos/control-plane";
import type { Runtime, ToolPort } from "@rovinos/core";
import type { HarnessConfig } from "@rovinos/config";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { IdempotencyKeyHashSchema, type RunQueue } from "@rovinos/store";
import { z } from "zod";
import type { CliContext, CommandModule } from "./command.js";
import { createCommandRuntime } from "./command.js";

type ServeErrorCode = "serve_options_invalid" | "serve_port_invalid" | "stdio_json_unsupported";
type ServeRuntimeErrorCode =
  "start_idempotency_unavailable" | "continue_run_failed" | "run_not_found";

class ServeCommandError extends HarnessError {
  override readonly code: ServeErrorCode;

  constructor(code: ServeErrorCode) {
    super(code);
    this.code = code;
  }
}

class ServeRuntimeError extends HarnessError {
  override readonly code: ServeRuntimeErrorCode;

  constructor(code: ServeRuntimeErrorCode) {
    super(code);
    this.code = code;
  }
}

const portSchema = z.coerce.number().int().min(0).max(65_535);

/** Registers `harness serve`, serving the control-plane over stdio or configured HTTP. */
export const serveCommand: CommandModule = {
  name: "serve",
  /** Registers the `serve` command. */
  register(program, context) {
    program
      .command("serve")
      .description("Serve the harness control plane over stdio or HTTP")
      .option("--stdio", "serve MCP over standard input and output")
      .option("--http", "serve MCP over configured HTTP")
      .option("--port <port>", "HTTP listener port")
      .action(
        async (options: {
          readonly stdio?: boolean;
          readonly http?: boolean;
          readonly port?: string;
        }) => {
          const mode = parseServeOptions(options, program.opts<{ json?: boolean }>().json === true);

          const config = await context.loadConfig();
          const queue = await openRunQueue(context, config);
          let tool: ToolPort | undefined;
          let runtime: Runtime;
          try {
            tool = await context.createToolPort?.(config);
            runtime = await createCommandRuntime(context, config, {
              ...(tool === undefined ? {} : { tool }),
              queue,
            });
          } catch (error) {
            await queue.close();
            throw error;
          }
          let closeServer: (() => Promise<void>) | undefined;
          try {
            const { startControlPlaneHttp, startControlPlaneStdio } =
              await import("@rovinos/control-plane");
            const operations = createControlPlaneOperations(runtime);
            const controlPlaneOptions = {
              ...(config.controlPlane === undefined ? {} : { controlPlane: config.controlPlane }),
              runQueue: queue,
              ...(context.secretResolver === undefined
                ? {}
                : { secretResolver: context.secretResolver }),
              clock: context.clock,
            };
            if (mode.http) {
              const handle = await startControlPlaneHttp(
                runtime.store,
                mode.port ?? config.controlPlane?.listen.port ?? 3_000,
                { ...controlPlaneOptions, operations },
              );
              closeServer = () => handle.close();
              context.out.json(ServeResultSchema, { status: "serving" });
              context.out.print(`${handle.endpoint}\n`);
              await waitForShutdown(false);
            } else {
              const handle = startControlPlaneStdio(runtime.store, {
                ...controlPlaneOptions,
                operations,
              });
              closeServer = () => handle.close();
              await waitForShutdown(true);
            }
          } finally {
            await closeServeResources(closeServer, runtime, queue);
          }
        },
      );
  },
};

async function openRunQueue(context: CliContext, config: HarnessConfig): Promise<RunQueue> {
  if (context.openRunQueue !== undefined) {
    return context.openRunQueue(config);
  }
  const { openConfiguredRunQueue } = await import("@rovinos/core");
  return openConfiguredRunQueue(config, {
    clock: context.clock,
    ...(context.dataDir === undefined ? {} : { dataDir: context.dataDir }),
    ...(context.secretResolver === undefined ? {} : { secretResolver: context.secretResolver }),
  });
}

async function closeServeResources(
  closeServer: (() => Promise<void>) | undefined,
  runtime: Runtime,
  queue: RunQueue,
): Promise<void> {
  try {
    await closeServer?.();
  } finally {
    try {
      await runtime.close();
    } finally {
      await queue.close();
    }
  }
}

function parseServeOptions(
  options: { readonly stdio?: boolean; readonly http?: boolean; readonly port?: string },
  json: boolean,
): { readonly http: boolean; readonly port?: number } {
  const http = options.http === true || options.stdio !== true;
  if ((options.stdio === true && options.http === true) || (options.port !== undefined && !http)) {
    throw new ServeCommandError("serve_options_invalid");
  }
  if (json && !http) {
    throw new ServeCommandError("stdio_json_unsupported");
  }
  if (options.port === undefined) {
    return { http };
  }
  const parsedPort = portSchema.safeParse(options.port);
  if (!parsedPort.success) {
    throw new ServeCommandError("serve_port_invalid");
  }
  return { http, port: parsedPort.data };
}

/** Creates control-plane mutation operations backed by a composed runtime. */
export function createControlPlaneOperations(runtime: Runtime): ControlPlaneOperations {
  return {
    startRun: (input) => startControlPlaneRun(runtime, input),
    continueRun: (runId, input) => continueControlPlaneRun(runtime, runId, input),
    resumeRun: (runId, signal, onClaimed) => runtime.resume(runId, { signal, onClaimed }),
    cancelRun: (runId) => runtime.cancel(runId),
    resolveApproval: async ({ runId, approvalId, decision, edits, reason, approverId }) => {
      await runtime.resolveApproval(runId, approvalId, decision, {
        ...(edits === undefined ? {} : { edits }),
        metadata: {
          decidedBy: "human",
          approverId,
          ...(reason === undefined ? {} : { reason }),
        },
      });
    },
  };
}

async function startControlPlaneRun(
  runtime: Runtime,
  {
    goal,
    metadata,
    role,
    idempotencyKey,
    requestedBy,
    allowedExistingRunIds,
    onProgress,
  }: Parameters<NonNullable<ControlPlaneOperations["startRun"]>>[0],
): Promise<{ readonly runId: Id; readonly status: RunStatus }> {
  const keyHash =
    idempotencyKey === undefined
      ? undefined
      : IdempotencyKeyHashSchema.parse(
          createHash("sha256")
            .update("harness/control-plane/idempotency/v1\0")
            .update(requestedBy)
            .update("\0")
            .update(idempotencyKey)
            .digest("hex"),
        );
  const candidateRunId = runtime.ids.next();
  const runId =
    keyHash === undefined
      ? candidateRunId
      : await claimRunIdempotencyKey(runtime, keyHash, candidateRunId);
  if (runId !== candidateRunId) {
    const events = [];
    for await (const event of runtime.store.read(runId)) {
      events.push(event);
    }
    if (events.length > 0) {
      if (allowedExistingRunIds !== undefined && !allowedExistingRunIds.includes(runId)) {
        throw new ServeRuntimeError("run_not_found");
      }
      const { foldRunState } = await import("@rovinos/core");
      return { runId, status: foldRunState(events).status };
    }
  }
  const runInput = JsonValue.parse({
    goal,
    ...(metadata === undefined ? {} : { metadata }),
  });
  const started = runtime.start(runInput, {
    runId,
    requestedBy,
    ...(role === undefined ? {} : { role }),
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  void started.completion.catch(() => undefined);
  try {
    await started.started;
  } catch (error) {
    if (keyHash !== undefined) {
      await releaseFailedStart(runtime, keyHash, runId);
    }
    throw error;
  }
  if (onProgress !== undefined) {
    const completion = await started.completion;
    return { runId, status: completion.status };
  }
  return { runId, status: "pending" };
}

async function releaseFailedStart(
  runtime: Runtime,
  keyHash: ReturnType<typeof IdempotencyKeyHashSchema.parse>,
  runId: Id,
): Promise<void> {
  try {
    if ((await runtime.store.head(runId)) === 0) {
      await runtime.store.releaseIdempotencyKey(keyHash, runId);
    }
  } catch {
    // Preserve the original start failure when releasing its claim cannot be confirmed.
    return;
  }
}

async function continueControlPlaneRun(
  runtime: Runtime,
  runId: Id,
  {
    goal,
    metadata,
    requestedBy,
  }: Parameters<NonNullable<ControlPlaneOperations["continueRun"]>>[1],
): Promise<{ readonly runId: Id; readonly status: RunStatus }> {
  const continuation = runtime.continueRun(
    runId,
    { goal, ...(metadata === undefined ? {} : { metadata }) },
    { requestedBy },
  );
  void continuation.completion.catch(() => undefined);
  await continuation.started;
  return { runId: continuation.runId, status: "pending" };
}

async function claimRunIdempotencyKey(
  runtime: Runtime,
  keyHash: ReturnType<typeof IdempotencyKeyHashSchema.parse>,
  candidateRunId: Id,
): Promise<Id> {
  let runId = await runtime.store.claimIdempotencyKey(keyHash, candidateRunId, runtime.clock.now());
  if (runId === candidateRunId) {
    return candidateRunId;
  }
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if ((await runtime.store.head(runId)) > 0) {
      return runId;
    }
    const now = runtime.clock.now();
    if (
      await runtime.store.takeoverIdempotencyKey(keyHash, {
        expectedRunId: runId,
        runId: candidateRunId,
        createdAt: now,
        staleBefore: now - 30_000,
      })
    ) {
      return candidateRunId;
    }
    runId = await runtime.store.claimIdempotencyKey(keyHash, candidateRunId, now);
    if (runId === candidateRunId) {
      return candidateRunId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new ServeRuntimeError("start_idempotency_unavailable");
}

/** Waits for a shutdown signal and observes stdin closure when using stdio. */
export function waitForShutdown(stdio: boolean): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const onShutdown = (): void => {
      clearInterval(keepAlive);
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
      process.stdin.off("end", onShutdown);
      resolve();
    };
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
    if (stdio) {
      process.stdin.once("end", onShutdown);
      if (process.stdin.readableEnded) {
        onShutdown();
      }
    }
  });
}
