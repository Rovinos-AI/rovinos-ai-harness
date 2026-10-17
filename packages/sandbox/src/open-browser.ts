// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

/** Opens a URL in the system browser without passing it through a shell. */
export function openUrlInBrowser(url: string): Promise<void> {
  let executable = "xdg-open";
  if (process.platform === "darwin") {
    executable = "open";
  } else if (process.platform === "win32") {
    executable = "explorer.exe";
  }
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(executable, [url], { detached: true, shell: false, stdio: "ignore" });
      child.once("error", () => {
        reject(new Error("browser_launch_failed"));
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } catch {
      reject(new Error("browser_launch_failed"));
    }
  });
}
