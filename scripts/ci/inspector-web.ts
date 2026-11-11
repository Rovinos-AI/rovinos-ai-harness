// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";

/** Running Inspector web process and its loopback URL. */
export interface RunningInspectorWebClient {
  readonly child: ChildProcess;
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Starts the pinned Inspector web client on its configured loopback port. */
export async function startInspectorWebClient(input: {
  readonly root: string;
  readonly launcher: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<RunningInspectorWebClient> {
  const child = spawn(process.execPath, [input.launcher, "--web"], {
    cwd: input.root,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startup = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("MCP Inspector web client did not start."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      startup += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(startup);
      if (match?.[0] !== undefined) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      reject(new Error(`MCP Inspector web client exited ${String(status)}.`));
    });
  });
  return {
    child,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const killTimeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("close", () => {
          clearTimeout(killTimeout);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
