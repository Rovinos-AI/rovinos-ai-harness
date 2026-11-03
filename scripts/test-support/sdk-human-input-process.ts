// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the SDK answer fixture in a separate Node process. */
export function runSdkInputAnswerProcess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const script = fileURLToPath(
    new URL("../../test/fixtures/sdk-human-input-answer.mjs", import.meta.url),
  );
  const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: repositoryRoot, encoding: "utf8", env, timeout: 60_000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error("The SDK human-input answer process failed."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
