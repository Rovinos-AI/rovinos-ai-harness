// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  ServeResultSchema,
  type Code,
  type Id,
  type JsonValue,
} from "@harness/schemas";
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

/** Registers `harness serve`, serving the control-plane over stdio or loopback HTTP. */
export const serveCommand: CommandModule = {
  name: "serve",
  register(program, context) {
    program
      .command("serve")
      .description("Serve the harness control plane over stdio or loopback HTTP")
      .option("--stdio", "serve MCP over standard input and output")
      .option("--http", "serve MCP over loopback HTTP")
      .option("--port <port>", "HTTP listener port")
      .action(
        async (options: {
          readonly stdio?: boolean;
          readonly http?: boolean;
          readonly port?: string;
        }) => {
          const http = options.http === true || options.stdio !== true;
          if (
            (options.stdio === true && options.http === true) ||
            (options.port !== undefined && !http)
          ) {
            throw new ServeCommandError("serve_options_invalid");
          }
          if (program.opts<{ json?: boolean }>().json === true && !http) {
            throw new ServeCommandError("stdio_json_unsupported");
          }
          let port = 3_000;
          if (http) {
            const parsedPort = portSchema.safeParse(options.port ?? "3000");
            if (!parsedPort.success) {
              throw new ServeCommandError("serve_port_invalid");
            }
            port = parsedPort.data;
          }

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
            const operations = {
              resumeRun: (runId: Parameters<typeof runtime.resume>[0]) => runtime.resume(runId),
              cancelRun: (runId: Parameters<typeof runtime.cancel>[0]) => runtime.cancel(runId),
              resolveApproval: async (
                runId: Parameters<typeof runtime.resume>[0],
                approvalId: Id,
                decision: "approve" | "deny" | "edit",
                edits?: JsonValue,
                reason?: Code,
              ) => {
                const { resolveApproval } = await import("@harness/core");
                await resolveApproval(
                  runtime.store,
                  runId,
                  approvalId,
                  decision,
                  edits,
                  runtime.clock,
                  tool,
                  {
                    decidedBy: "human",
                    ...(reason === undefined ? {} : { reason }),
                  },
                );
              },
            };
            if (http) {
              const handle = await startControlPlaneHttp(runtime.store, port, { operations });
              closeServer = () => handle.close();
              context.out.json(ServeResultSchema, { status: "serving" });
              context.out.print(`${handle.endpoint}\n`);
              await waitForShutdown(false);
            } else {
              const handle = startControlPlaneStdio(runtime.store, { operations });
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

function waitForShutdown(stdio: boolean): Promise<void> {
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
