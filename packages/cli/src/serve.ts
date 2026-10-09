// SPDX-License-Identifier: Apache-2.0
import type { CommandModule } from "./command.js";

/** Keeps the harness container alive until it receives a termination signal. */
export const serveCommand: CommandModule = {
  name: "serve",
  register(program) {
    program
      .command("serve")
      .description("Run until the process receives SIGINT or SIGTERM")
      .action(async () => {
        await waitForShutdown();
      });
  },
};

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const onShutdown = (): void => {
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
      resolve();
    };
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
  });
}
