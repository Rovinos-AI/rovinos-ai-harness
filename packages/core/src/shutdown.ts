// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";

type ShutdownSignal = "SIGINT" | "SIGTERM";
interface ShutdownLogger {
  error(event: Code): void;
}

/** Minimal process interface used by the shutdown handler and injectable in tests. */
export interface ShutdownProcessLike {
  on(signal: ShutdownSignal, listener: () => void): unknown;
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

/** Returns the existing value only when the abort was caused by shutdown. */
export function onShutdown<Result>(
  signal: AbortSignal,
  result: Result | undefined,
): Result | undefined {
  return signal.reason === "shutdown" ? result : undefined;
}

/**
 * Aborts the run on the first termination signal and exits if the grace period expires.
 *
 * The timeout callback can make a best-effort checkpoint before the process is forced out.
 *
 * @param options - Process, run controller, grace period, and timeout callback.
 * @returns A function that removes both signal listeners and clears the pending timeout.
 */
export function installShutdownHandler(options: ShutdownHandlerOptions): () => void {
  const processLike = options.processLike;
  let installed = true;
  let signalReceived = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const handleSignal = (signal: ShutdownSignal): void => {
    if (!installed || signalReceived) {
      return;
    }
    signalReceived = true;
    processLike.exitCode = signal === "SIGTERM" ? 143 : 130;
    options.controller.abort("shutdown");
    timeout = setTimeout(() => {
      void forceExit();
    }, options.graceMs);
    timeout.unref?.();
  };

  const handleSigterm = (): void => {
    handleSignal("SIGTERM");
  };
  const handleSigint = (): void => {
    handleSignal("SIGINT");
  };
  processLike.on("SIGTERM", handleSigterm);
  processLike.on("SIGINT", handleSigint);

  const uninstall = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    processLike.removeListener("SIGTERM", handleSigterm);
    processLike.removeListener("SIGINT", handleSigint);
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
      let checkpointDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve()
            .then(options.onTimeout)
            .catch(() => undefined),
          new Promise<void>((resolve) => {
            checkpointDeadline = setTimeout(resolve, Math.min(5_000, options.graceMs));
          }),
        ]);
      } finally {
        if (checkpointDeadline !== undefined) {
          clearTimeout(checkpointDeadline);
        }
      }
    } catch {
      // A best-effort checkpoint must not prevent a forced exit.
    }
    try {
      (options.logger ?? noopLogger).error("shutdown_timeout");
    } catch {
      // Logging failure must not prevent a forced exit.
    }
    processLike.exitCode = 1;
    processLike.exit(1);
  };

  return uninstall;
}
