// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneConfigSchema, Id, type NewEvent } from "@rovinos/schemas";
import { SqliteEventStore } from "@rovinos/store-sqlite";

export const INSPECTOR_HTTP_TOKEN = "INSPECTOR_CONFORMANCE_TEST_TOKEN_LONG_ENOUGH";
export const INSPECTOR_READ_TOKEN = "INSPECTOR_RESTRICTED_TOKEN_LONG_ENOUGH";

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
    CONTROL_PLANE_RESTRICTED_TOKEN: INSPECTOR_READ_TOKEN,
    MCP_INSPECTOR_SECRET_STORE: "memory",
    MCP_STORAGE_DIR: join(home, "storage"),
    MCP_CATALOG_PATH: join(home, "catalog.json"),
    MCP_AUTO_OPEN_ENABLED: "false",
  };
}

/** A loopback-only harness fixture shared by Inspector and MCP conformance tests. */
export interface InspectorFixture {
  readonly endpoint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly workDir: string;
  close(): Promise<void>;
}

/** Creates an isolated, seeded harness server with synthetic admin and read-only tokens. */
export async function startInspectorFixture(input: {
  readonly root: string;
  readonly harness: string;
}): Promise<InspectorFixture> {
  const workDir = await mkdtemp(join(tmpdir(), "harness-inspector-conformance-"));
  const home = join(workDir, "home");
  const dataDir = join(workDir, "data");
  const configPath = join(workDir, "harness.config.json");
  let server: RunningInspectorServer | undefined;
  try {
    await Promise.all([mkdir(home), mkdir(dataDir)]);
    const controlPlane = ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.inspector",
            secret: "env:CONTROL_PLANE_INSPECTOR_TOKEN",
            scopes: ["admin"],
          },
          {
            id: "token.inspector.read",
            secret: "env:CONTROL_PLANE_RESTRICTED_TOKEN",
            scopes: ["read"],
          },
        ],
      },
    });
    await writeFile(configPath, `${JSON.stringify({ controlPlane })}\n`, { mode: 0o600 });
    await seedSyntheticRun(dataDir);
    const env = minimalInspectorEnvironment(home, configPath, dataDir);
    server = await startInspectorHttpServer({ ...input, env });
    return {
      endpoint: server.endpoint,
      env,
      home,
      workDir,
      close: async () => {
        await server?.close();
        await rm(workDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function seedSyntheticRun(dataDir: string): Promise<void> {
  const store = new SqliteEventStore(join(dataDir, "harness.db"));
  try {
    const runId = Id.parse("00000000000000000000000001");
    const event: NewEvent = {
      runId,
      ts: 1,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    };
    await store.append(runId, [event], 0);
  } finally {
    await store.close();
  }
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
