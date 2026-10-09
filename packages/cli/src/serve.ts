// SPDX-License-Identifier: Apache-2.0
import { ServeResultSchema } from "@harness/schemas";
import type { CommandModule } from "./command.js";

/** Keeps the harness container alive until it receives a termination signal. */
export const serveCommand: CommandModule = {
  name: "serve",
  register(program, ctx) {
    program
      .command("serve")
      .description("Run until the process receives SIGINT or SIGTERM")
      .action(async () => {
        ctx.out.json(ServeResultSchema, { status: "serving" });
        await waitForShutdown();
      });
  },
};

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const onShutdown = (): void => {
      clearInterval(keepAlive);
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
      resolve();
    };
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
  });
}
