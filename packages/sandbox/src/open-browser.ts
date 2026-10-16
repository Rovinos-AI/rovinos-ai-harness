// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";

/** Opens a URL in the system browser without passing it through a shell. */
export function openUrlInBrowser(url: string): Promise<void> {
  const executable =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(executable, [url], { detached: true, shell: false, stdio: "ignore" });
      child.once("error", () => reject(new Error("browser_launch_failed")));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } catch {
      reject(new Error("browser_launch_failed"));
    }
  });
}
