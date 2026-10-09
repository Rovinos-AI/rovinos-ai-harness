// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";

type ShutdownSignal = "SIGINT" | "SIGTERM";
interface ShutdownLogger {
  error(event: Code): void;
}

/** Minimal process interface used by the shutdown handler and injectable in tests. */
export interface ShutdownProcessLike {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
  exitCode: number | undefined;
  exit(code: number): never | void;
}

/** Dependencies for installing graceful process-signal handling. */
export interface ShutdownHandlerOptions {
  readonly processLike: ShutdownProcessLike;
  readonly controller: AbortController;
  readonly graceMs: number;
  readonly onTimeout: () => void | Promise<void>;
  readonly logger?: ShutdownLogger;
}

const noopLogger: ShutdownLogger = { error: () => undefined };

/**
 * Aborts the run on the first termination signal and exits if the grace period expires.
 *
 * The timeout callback can make a best-effort checkpoint before the process is forced out.
 *
 * @param options - Process, run controller, grace period, and timeout callback.
 * @returns A function that removes both signal listeners and clears the pending timeout.
 */
export function installShutdownHandler(options: ShutdownHandlerOptions): () => void {
  let installed = true;
  let signalReceived = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const handleSignal = (signal: ShutdownSignal): void => {
    if (!installed || signalReceived) {
      return;
    }
    signalReceived = true;
    options.processLike.exitCode = signal === "SIGTERM" ? 143 : 130;
    options.controller.abort("shutdown");
    timeout = setTimeout(() => {
      void forceExit();
    }, options.graceMs);
  };

  const handleSigterm = (): void => handleSignal("SIGTERM");
  const handleSigint = (): void => handleSignal("SIGINT");
  options.processLike.once("SIGTERM", handleSigterm);
  options.processLike.once("SIGINT", handleSigint);

  const uninstall = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    options.processLike.removeListener("SIGTERM", handleSigterm);
    options.processLike.removeListener("SIGINT", handleSigint);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  };

  const forceExit = async (): Promise<void> => {
    if (!installed) {
      return;
    }
    uninstall();
    try {
      await options.onTimeout();
    } catch {
      // A best-effort checkpoint must not prevent a forced exit.
    }
    (options.logger ?? noopLogger).error("shutdown_timeout");
    options.processLike.exitCode = 1;
    options.processLike.exit(1);
  };

  return uninstall;
}
