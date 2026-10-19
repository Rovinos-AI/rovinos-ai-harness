// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export const INSPECTOR_HTTP_TOKEN = "INSPECTOR_CONFORMANCE_TOKEN";

/** Running HTTP server process and its MCP endpoint. */
export interface RunningInspectorServer {
  readonly child: ChildProcess;
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

/** Creates the isolated environment used by Inspector conformance processes. */
export function minimalInspectorEnvironment(
  home: string,
  configPath: string,
  dataDir: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    HARNESS_CONFIG: configPath,
    HARNESS_DATA_DIR: dataDir,
    CONTROL_PLANE_INSPECTOR_TOKEN: INSPECTOR_HTTP_TOKEN,
    MCP_INSPECTOR_SECRET_STORE: "memory",
    MCP_STORAGE_DIR: join(home, "storage"),
    MCP_CATALOG_PATH: join(home, "catalog.json"),
    MCP_AUTO_OPEN_ENABLED: "false",
  };
}

/** Starts the harness HTTP server and resolves its bound loopback URL. */
export async function startInspectorHttpServer(input: {
  readonly root: string;
  readonly harness: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<RunningInspectorServer> {
  const child = spawn(process.execPath, [input.harness, "serve", "--http", "--port", "0"], {
    cwd: input.root,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("harness serve --http timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/u.exec(stdout);
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
      reject(new Error(`harness serve --http exited ${String(status)}.`));
    });
  });
  return {
    child,
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
