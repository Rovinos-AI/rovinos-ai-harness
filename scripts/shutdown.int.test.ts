// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const shutdownModuleUrl = pathToFileURL(
  fileURLToPath(new URL("../packages/core/src/shutdown.ts", import.meta.url)),
).href;

describe("installShutdownHandler process signals", () => {
  it("gracefully exits after receiving SIGTERM twice", async () => {
    const script = `
      const { installShutdownHandler } = await import(${JSON.stringify(shutdownModuleUrl)});
      const controller = new AbortController();
      installShutdownHandler({
        processLike: process,
        controller,
        graceMs: 2000,
        onTimeout: () => undefined,
      });
      const keepAlive = setInterval(() => undefined, 1000);
      controller.signal.addEventListener("abort", () => {
        process.stdout.write("aborted\\n");
        setTimeout(() => clearInterval(keepAlive), 100);
      }, { once: true });
      process.stdout.write("ready\\n");
    `;
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        script,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }>((resolve, reject) => {
      let output = "";
      let sentFirstSignal = false;
      let sentSecondSignal = false;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Child process did not exit after shutdown."));
      }, 5_000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (!sentFirstSignal && output.includes("ready\n")) {
          sentFirstSignal = true;
          child.kill("SIGTERM");
        }
        if (!sentSecondSignal && output.includes("aborted\n")) {
          sentSecondSignal = true;
          child.kill("SIGTERM");
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, output });
      });
    });

    expect(result).toMatchObject({ code: 143, signal: null });
    expect(result.output).toContain("aborted\n");
  }, 10_000);
});
