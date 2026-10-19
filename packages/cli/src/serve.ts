// SPDX-License-Identifier: Apache-2.0
import { HarnessError, ServeResultSchema } from "@harness/schemas";
import type { ControlPlaneOperations } from "@harness/control-plane";
import type { Runtime, ToolPort } from "@harness/core";
import { z } from "zod";
import type { CommandModule } from "./command.js";
import { createCommandRuntime } from "./command.js";

type ServeErrorCode = "serve_options_invalid" | "serve_port_invalid" | "stdio_json_unsupported";

class ServeCommandError extends HarnessError {
  override readonly code: ServeErrorCode;

  constructor(code: ServeErrorCode) {
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
          const tool = await context.createToolPort?.(config);
          const runtime = await createCommandRuntime(
            context,
            config,
            tool === undefined ? undefined : { tool },
          );
          let closeServer: (() => Promise<void>) | undefined;
          try {
            const { startControlPlaneHttp, startControlPlaneStdio } =
              await import("@harness/control-plane");
            const operations = createControlPlaneOperations(runtime, tool);
            const controlPlaneOptions = {
              ...(config.controlPlane === undefined ? {} : { controlPlane: config.controlPlane }),
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
            try {
              await closeServer?.();
            } finally {
              await runtime.close();
            }
          }
        },
      );
  },
};

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

function createControlPlaneOperations(
  runtime: Runtime,
  tool: ToolPort | undefined,
): ControlPlaneOperations {
  return {
    resumeRun: (runId, signal, onClaimed) => runtime.resume(runId, { signal, onClaimed }),
    cancelRun: (runId) => runtime.cancel(runId),
    resolveApproval: async ({ runId, approvalId, decision, edits, reason }) => {
      const { resolveApproval } = await import("@harness/core");
      await resolveApproval(
        runtime.store,
        runId,
        approvalId,
        decision,
        edits,
        runtime.clock,
        tool,
        { decidedBy: "human", ...(reason === undefined ? {} : { reason }) },
      );
    },
  };
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
