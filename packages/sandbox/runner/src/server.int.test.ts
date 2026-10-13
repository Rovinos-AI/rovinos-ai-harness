// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Id, parseJson } from "@harness/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecResultSchema } from "../../src/types.js";
import type { ExecSpec } from "../../src/types.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const projectName = `harness-sandbox-runner-${String(process.pid)}`;
const integrationToken = "synthetic-runner-token-for-integration";
const composeFile = "infra/compose/docker-compose.yml";
const integrationUid = process.getuid?.() ?? 10002;
const integrationGid = process.getgid?.() ?? 10002;
const composeEnvironment = {
  ...process.env,
  SANDBOX_RUNNER_TOKEN_SOURCE: "",
  SANDBOX_RUNNER_UID: String(integrationUid),
  SANDBOX_RUNNER_GID: String(integrationGid),
};
let tokenDirectory: string | undefined;

const ComposeSchema = z.object({
  networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })),
  services: z.record(
    z.string(),
    z.object({
      cpus: z.number().optional(),
      cap_add: z.array(z.string()).optional(),
      cap_drop: z.array(z.string()).optional(),
      entrypoint: z
        .union([z.array(z.string()), z.string()])
        .nullable()
        .optional(),
      mem_limit: z.union([z.string(), z.number()]).optional(),
      networks: z.record(z.string(), z.unknown()).optional(),
      pids_limit: z.number().optional(),
      ports: z.array(z.unknown()).optional(),
      privileged: z.boolean().optional(),
      read_only: z.boolean().optional(),
      user: z.string().optional(),
      volumes: z
        .array(
          z.object({
            source: z.string().optional(),
            target: z.string().optional(),
            type: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
const HttpResponseSchema = z.object({ status: z.number().int(), body: z.string() }).strict();
const ChildCapabilitiesSchema = z
  .object({
    values: z
      .object({
        CapInh: z.string(),
        CapPrm: z.string(),
        CapEff: z.string(),
        CapBnd: z.string(),
        CapAmb: z.string(),
      })
      .strict(),
    uidError: z.string(),
    gidError: z.string(),
    supplementaryGroups: z.array(z.number().int()),
    tokenFileReadable: z.boolean(),
    tokenInProcessEnvironment: z.boolean(),
    signalError: z.string(),
  })
  .strict();

function composeArgs(args: string[]): string[] {
  return [
    "compose",
    "--env-file",
    "infra/collector/VERSION",
    "--project-name",
    projectName,
    "--profile",
    "sandbox",
    "--file",
    composeFile,
    ...args,
  ];
}

async function runCompose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", composeArgs(args), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function readRenderedComposeConfig(): z.infer<typeof ComposeSchema> {
  const output = execFileSync("docker", composeArgs(["config", "--format", "json"]), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
  });
  return parseJson(ComposeSchema, output);
}

async function executeInRunner(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--project-name",
      projectName,
      "--profile",
      "sandbox",
      "--file",
      composeFile,
      "exec",
      "--no-TTY",
      "sandbox-runner",
      "node",
      "-e",
      script,
    ],
    { cwd: root, env: composeEnvironment, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

async function requestRunner(
  body: unknown,
  options: { readonly token?: string; readonly host?: string; readonly origin?: string } = {},
): Promise<z.infer<typeof HttpResponseSchema>> {
  const headers = {
    host: options.host ?? "sandbox-runner:8080",
    ...(options.token === undefined ? {} : { authorization: ["Bearer", options.token].join(" ") }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    "content-type": "application/json",
  };
  const script = [
    'const http = require("node:http");',
    `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: "/exec", method: "POST", headers: ${JSON.stringify(headers)} }, (response) => {`,
    '  const chunks = []; response.on("data", (chunk) => chunks.push(chunk));',
    '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
    "});",
    `request.end(${JSON.stringify(JSON.stringify(body))});`,
  ].join("\n");
  const output = await executeInRunner(script);
  return parseJson(HttpResponseSchema, output);
}

function makeSpec(argv: string[], options: Partial<ExecSpec> = {}): ExecSpec {
  return {
    argv,
    timeoutMs: 5000,
    limits: { memoryMb: 2048, pids: 2048, outputBytes: 2048, cpuSeconds: 5 },
    ...options,
  };
}

async function runExec(spec: ExecSpec): Promise<z.infer<typeof ExecResultSchema>> {
  const response = await requestRunner(
    { runId: Id.parse("00000000000000000000000001"), spec },
    { token: integrationToken },
  );
  expect(response.status).toBe(200);
  return parseJson(ExecResultSchema, response.body);
}

describe("sandbox runner Compose service", () => {
  beforeAll(async () => {
    tokenDirectory = await mkdtemp(join(tmpdir(), "sandbox-runner-integration-"));
    const tokenFile = join(tokenDirectory, "runner-token");
    await writeFile(tokenFile, integrationToken, { mode: 0o400 });
    composeEnvironment.SANDBOX_RUNNER_TOKEN_SOURCE = tokenFile;
    await runCompose(["up", "--detach", "--wait", "--pull=missing", "--build", "sandbox-runner"]);
  }, 180_000);

  afterAll(async () => {
    await runCompose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
    if (tokenDirectory !== undefined) {
      await rm(tokenDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  // threat: T-01
  // threat: T-04
  it("has no host runtime or secret mounts, privileged mode, or published ports", () => {
    const config = readRenderedComposeConfig();
    const runner = config.services["sandbox-runner"];
    expect(runner).toBeDefined();
    expect(runner?.privileged).not.toBe(true);
    expect(runner?.ports ?? []).toHaveLength(0);
    expect(runner?.volumes?.some((volume) => volume.type === "bind")).toBe(false);
    expect(
      runner?.volumes?.some(
        (volume) =>
          volume.source?.includes("docker.sock") === true ||
          volume.target?.includes("docker.sock") === true,
      ),
    ).toBe(false);
    expect(config.networks.sandbox?.internal).toBe(true);
    expect(Object.keys(runner?.networks ?? {})).toEqual(["sandbox"]);
    expect(runner?.read_only).toBe(true);
    expect(runner?.user).toBe("0:0");
    expect(runner?.entrypoint).toContain(`--reuid=${String(integrationUid)}`);
    expect(runner?.entrypoint).toContain(`--regid=${String(integrationGid)}`);
    expect(runner?.cap_drop).toEqual(["ALL"]);
    expect(runner?.cap_add).toEqual(["SETUID", "SETGID", "SETPCAP"]);
    expect(runner?.pids_limit).toBeGreaterThan(0);
    expect(runner?.mem_limit).toBeDefined();
    expect(runner?.cpus).toBeGreaterThan(0);
  });

  it("echoes argv over the authenticated API", async () => {
    const result = await runExec(makeSpec(["/bin/echo", "runner-ready"]));

    expect(result).toMatchObject({ exitCode: 0, stdout: "runner-ready\n" });
  });

  // threat: T-02
  it("runs commands under the dedicated execution uid and gid", async () => {
    const result = await runExec(
      makeSpec([
        "node",
        "-e",
        "process.stdout.write(`${String(process.getuid())}:${String(process.getgid())}`)",
      ]),
    );

    expect(result.stdout).toBe("10003:10003");
    expect(result.stdout).not.toBe(`${String(integrationUid)}:${String(integrationGid)}`);
  });

  // threat: T-02
  // threat: T-18
  it("gives sandbox commands no capabilities and denies credential escalation (T-02, T-18)", async () => {
    const script = [
      'const fs = require("node:fs");',
      'const status = fs.readFileSync("/proc/self/status", "utf8");',
      'const capabilities = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];',
      'const values = Object.fromEntries(capabilities.map((name) => [name, status.match(new RegExp(`^${name}:\\\\s+([0-9a-f]+)$`, "m"))?.[1]]));',
      'let uidError = ""; let gidError = "";',
      'try { process.setuid(10002); } catch (error) { uidError = error.code ?? ""; }',
      'try { process.setgid(10002); } catch (error) { gidError = error.code ?? ""; }',
      "const supplementaryGroups = process.getgroups().filter((group) => group !== process.getgid());",
      'let tokenFileReadable = false; let tokenInProcessEnvironment = false; let signalError = "";',
      'try { tokenFileReadable = fs.readFileSync("/run/secrets/sandbox_runner_token", "utf8").includes("synthetic-runner-token-for-integration"); } catch {}',
      'try { tokenInProcessEnvironment = fs.readFileSync("/proc/1/environ", "utf8").includes("synthetic-runner-token-for-integration"); } catch {}',
      'try { process.kill(1, "SIGKILL"); } catch (error) { signalError = error.code ?? ""; }',
      "process.stdout.write(JSON.stringify({ values, uidError, gidError, supplementaryGroups, tokenFileReadable, tokenInProcessEnvironment, signalError }));",
    ].join("\n");
    const result = await runExec(makeSpec(["node", "-e", script]));
    const parsed = parseJson(ChildCapabilitiesSchema, result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed).toEqual({
      values: {
        CapInh: "0000000000000000",
        CapPrm: "0000000000000000",
        CapEff: "0000000000000000",
        CapBnd: "0000000000000000",
        CapAmb: "0000000000000000",
      },
      uidError: "EPERM",
      gidError: "EPERM",
      supplementaryGroups: [],
      tokenFileReadable: false,
      tokenInProcessEnvironment: false,
      signalError: "EPERM",
    });
    expect(await readRunnerHealthStatus()).toBe(200);
  });

  // threat: T-18
  it("rejects requests without a valid runner token", async () => {
    const response = await requestRunner({
      runId: Id.parse("00000000000000000000000001"),
      spec: makeSpec(["/bin/echo", "not-authorized"]),
    });

    expect(response.status).toBe(401);
  });

  // threat: T-19
  it("rejects unapproved Host and Origin authorities", async () => {
    const payload = {
      runId: Id.parse("00000000000000000000000001"),
      spec: makeSpec(["/bin/echo", "not-authorized"]),
    };
    const wrongHost = await requestRunner(payload, {
      token: integrationToken,
      host: "untrusted.test",
    });
    const wrongOrigin = await requestRunner(payload, {
      token: integrationToken,
      origin: "https://untrusted.test",
    });

    expect(wrongHost.status).toBe(400);
    expect(wrongOrigin.status).toBe(400);
  });

  // threat: T-07
  it("contains a process-spawning workload within the per-exec process limit", async () => {
    const script = [
      "(async () => {",
      '  const { spawn } = require("node:child_process");',
      "  const children = [];",
      "  for (let index = 0; index < 64; index += 1) {",
      '    const child = spawn("/bin/sleep", ["5"], { stdio: "ignore" });',
      '    child.once("spawn", () => children.push(child));',
      '    child.once("error", () => undefined);',
      "  }",
      "  await new Promise((resolve) => setTimeout(resolve, 250));",
      '  for (const child of children) child.kill("SIGKILL");',
      "  process.stdout.write(String(children.length));",
      "})().catch(() => { process.exitCode = 1; });",
    ].join("\n");
    const result = await runExec(
      makeSpec(["node", "-e", script], {
        limits: { memoryMb: 2048, pids: 32, outputBytes: 128, cpuSeconds: 5 },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout)).toBeLessThan(32);
    expect(await readRunnerHealthStatus()).toBe(200);
  }, 30_000);

  // threat: T-08
  it("contains a memory-hogging process", async () => {
    const result = await runExec(
      makeSpec(
        ["/usr/bin/dd", "if=/dev/zero", "of=/dev/null", "bs=256M", "count=1", "status=none"],
        {
          limits: { memoryMb: 128, pids: 16, outputBytes: 128, cpuSeconds: 5 },
        },
      ),
    );

    expect(result.exitCode).not.toBe(0);
  }, 30_000);

  // threat: T-10
  it("kills an infinite loop at the request timeout", async () => {
    const result = await runExec(
      makeSpec(["/bin/sleep", "10"], {
        timeoutMs: 500,
        limits: { memoryMb: 2048, pids: 16, outputBytes: 128, cpuSeconds: 5 },
      }),
    );

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  }, 30_000);

  // threat: T-16
  it("cannot write to the read-only container root", async () => {
    const script =
      'try { require("node:fs").writeFileSync("/sandbox-runner-root-probe", "test"); process.stdout.write("writable"); } catch (error) { process.stdout.write(error.code ?? "denied"); }';
    const result = await runExec(makeSpec(["node", "-e", script]));

    expect(result.stdout).not.toBe("writable");
  });

  // threat: T-02
  // threat: T-03
  // threat: T-04
  it("keeps the runner token inaccessible to commands (T-02, T-18)", async () => {
    const script = [
      'const fs = require("node:fs");',
      'let token = ""; let proc = "";',
      'try { token = fs.readFileSync("/run/secrets/sandbox_runner_token", "utf8"); } catch {}',
      'try { proc = fs.readFileSync("/proc/1/environ", "utf8"); } catch {}',
      'process.stdout.write(String(token.includes("synthetic-runner-token-for-integration") || proc.includes("synthetic-runner-token-for-integration")));',
    ].join("\n");
    const result = await runExec(makeSpec(["node", "-e", script]));

    expect(result).toMatchObject({ exitCode: 0, stdout: "false" });
  });

  // threat: T-02
  it("cannot signal the runner and leaves health available (T-02, T-18)", async () => {
    const result = await runExec(
      makeSpec([
        "node",
        "-e",
        'try { process.kill(1, "SIGKILL"); process.stdout.write("signaled"); } catch (error) { process.stdout.write(error.code ?? "denied"); }',
      ]),
    );

    expect(result.stdout).toBe("EPERM");
    expect(await readRunnerHealthStatus()).toBe(200);
  });
});

async function readRunnerHealthStatus(): Promise<number> {
  const script = [
    'const http = require("node:http");',
    'http.get({ hostname: "127.0.0.1", port: 8080, path: "/healthz", headers: { host: "sandbox-runner:8080" } }, (response) => {',
    '  response.resume(); response.on("end", () => process.stdout.write(String(response.statusCode)));',
    '}).on("error", () => process.stdout.write("0"));',
  ].join("\n");
  return Number(await executeInRunner(script));
}
