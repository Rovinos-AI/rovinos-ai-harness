// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { HarnessConfig } from "@harness/config";
import type { Runtime } from "@harness/core";
import type { RunQueue } from "@harness/store";
import { z } from "zod";
import type { CliContext, CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";

const concurrencySchema = z.coerce.number().int().min(1).max(1000);
const workerStartedSchema = z.object({ status: z.literal("worker_started") }).strict();

class WorkerCommandError extends HarnessError {
  readonly code = "worker_concurrency_invalid";

  constructor() {
    super("Worker concurrency is invalid.");
  }
}

type WorkerRuntime = Pick<Runtime, "ids" | "clock" | "close"> & {
  resume(
    runId: Parameters<Runtime["resume"]>[0],
    options: Parameters<Runtime["resume"]>[1],
  ): Promise<Pick<Awaited<ReturnType<Runtime["resume"]>>, "status">>;
};

interface WorkerProcessLike {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Injectable edges for the worker CLI command. */
export interface WorkerCommandDependencies {
  readonly openQueue?: (config: HarnessConfig, context: CliContext) => Promise<RunQueue>;
  readonly createRuntime?: (
    context: CliContext,
    config: HarnessConfig,
    queue: RunQueue,
  ) => Promise<WorkerRuntime>;
  readonly processLike?: WorkerProcessLike;
}

async function openQueue(config: HarnessConfig, context: CliContext): Promise<RunQueue> {
  if (context.openRunQueue !== undefined) {
    return context.openRunQueue(config);
  }
  const { openConfiguredRunQueue } = await import("@harness/core");
  return openConfiguredRunQueue(config, {
    clock: context.clock,
    ...(context.dataDir === undefined ? {} : { dataDir: context.dataDir }),
    ...(context.secretResolver === undefined ? {} : { secretResolver: context.secretResolver }),
  });
}

/** Registers `harness worker`, which continuously drains the configured run queue. */
export function createWorkerCommand(dependencies: WorkerCommandDependencies = {}): CommandModule {
  return {
    name: "worker",
    register(program, context) {
      program
        .command("worker")
        .description("Run queue jobs using the configured runtime")
        .option("--concurrency <n>", "maximum number of simultaneous runs", "1")
        .action(async (options: { readonly concurrency: string }) => {
          const concurrency = concurrencySchema.safeParse(options.concurrency);
          if (!concurrency.success) {
            throw new WorkerCommandError();
          }
          const config = await context.loadConfig();
          const queue = await (dependencies.openQueue ?? openQueue)(config, context);
          let runtime: WorkerRuntime;
          try {
            runtime =
              dependencies.createRuntime === undefined
                ? await createCommandRuntime(context, config, { queue })
                : await dependencies.createRuntime(context, config, queue);
          } catch (error) {
            await queue.close();
            throw error;
          }
          const processLike = dependencies.processLike ?? process;
          let stop: (() => void) | undefined;
          try {
            const { RunAlreadyTerminalError, Worker } = await import("@harness/core");
            const worker = new Worker({
              queue,
              ids: runtime.ids,
              clock: runtime.clock,
              concurrency: concurrency.data,
              execute: async (job, signal) => {
                try {
                  return await runtime.resume(job.runId, { signal });
                } catch (error) {
                  if (error instanceof RunAlreadyTerminalError) {
                    return { status: "completed" };
                  }
                  throw error;
                }
              },
            });
            stop = (): void => {
              worker.stop();
            };
            processLike.once("SIGTERM", stop);
            processLike.once("SIGINT", stop);
            if (program.opts<{ json?: boolean }>().json === true) {
              context.out.json(workerStartedSchema, { status: "worker_started" });
            } else {
              context.out.print("worker_started\n");
            }
            await worker.run();
          } finally {
            if (stop !== undefined) {
              processLike.removeListener("SIGTERM", stop);
              processLike.removeListener("SIGINT", stop);
            }
            try {
              await runtime.close();
            } finally {
              await queue.close();
            }
          }
        });
    },
  };
}

export const workerCommand = createWorkerCommand();
